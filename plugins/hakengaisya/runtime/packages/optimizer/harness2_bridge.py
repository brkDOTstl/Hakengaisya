"""Run the pinned Harness2 core through bounded, local host request/response files."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import threading

REVISION = "1cfe254e8d25b15f37048c3730134686abe60335"
SURFACE = {"systemprompt.md", "guardrails.md", "LongTermMEMORY.md", "tool_descriptions/tool_guidance.md"}
MAX_BYTES = 512 * 1024


class Stop(BaseException):
    """Escape upstream fallback handling for pending input and contract failures."""

    def __init__(self, status, reason=""):
        self.status, self.reason = status, reason


def require(condition, message):
    if not condition:
        raise Stop("blocked", message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def fingerprint(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def read_json(path):
    require(path.is_file() and not path.is_symlink(), "Expected an ordinary local JSON file")
    require(path.stat().st_size <= MAX_BYTES, "Host record exceeds the local size limit")
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (ValueError, OSError):
        raise Stop("blocked", "Invalid local JSON record") from None


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    require(len(content.encode()) <= MAX_BYTES, "Host record exceeds the local size limit")
    temporary = path.with_suffix(".tmp")
    temporary.write_text(content, encoding="utf-8")
    os.replace(temporary, path)


def inspect_tree(root, *, bounded=True):
    files = {}
    for path in sorted(root.rglob("*")):
        require(not path.is_symlink() and not path.is_junction(), "Links are not allowed in learning state")
        if path.is_file():
            require(path.stat().st_size <= MAX_BYTES, "Context file exceeds the size limit")
            if bounded:
                files[path.relative_to(root).as_posix()] = path.read_text(encoding="utf-8")
    require(len(files) <= 512 and len(canonical(files).encode()) <= MAX_BYTES, "Learning context exceeds the bounded snapshot size")
    return files


def materialize(files, root):
    for relative, content in files.items():
        parts = relative.replace("\\", "/").split("/")
        require(parts and all(part and part not in (".", "..") and ":" not in part for part in parts), "Invalid local snapshot path")
        require(isinstance(content, str), "Snapshot contents must be text")
        target = root.joinpath(*parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")


def load_upstream(source):
    if source:
        checkout = Path(source).resolve()
        result = subprocess.run(["git", "-C", str(checkout), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10)
        require(result.returncode == 0 and result.stdout.strip() == REVISION, "Use the documented pinned Harness2 revision")
        require(not subprocess.run(["git", "-C", str(checkout), "status", "--porcelain", "--untracked-files=no"], capture_output=True, text=True, timeout=10).stdout.strip(), "The upstream checkout has tracked modifications")
        sys.path.insert(0, str(checkout))
    else:
        try:
            require(importlib.metadata.version("harness2") == "0.1.0", "Unsupported Harness2 package version")
        except importlib.metadata.PackageNotFoundError:
            raise Stop("unavailable", "Install the optional pinned Harness2 package or pass --upstream CHECKOUT") from None
    from harness2.core import library, recursion, selection, tree
    from harness2.core.proposer import Reply
    from harness2.core.spec import BenchPrompts, BenchSpec, ChannelSpec, RunView
    from harness2.substrate.opencode import OpencodeSubstrate
    return library, recursion, selection, tree, Reply, BenchPrompts, BenchSpec, ChannelSpec, RunView, OpencodeSubstrate


class Host:
    def __init__(self, job, session):
        self.job, self.session, self.lock = job, session, threading.Lock()
        (session / "requests").mkdir(exist_ok=True)
        (session / "responses").mkdir(exist_ok=True)

    def ask(self, kind, label, actor, payload):
        body = {"version": 1, "job_id": self.job["job_id"], "job_fingerprint": self.job["job_fingerprint"], "kind": kind, "label": label, "actor_context": actor, "payload": payload}
        request_digest = fingerprint(body)
        request_id = "request-" + request_digest[:32]
        request = {**body, "request_id": request_id, "request_fingerprint": request_digest}
        filename = self.session / "requests" / (request_id + ".json")
        with self.lock:
            if not filename.exists():
                require(len(list((self.session / "requests").glob("*.json"))) < self.job["policy"]["max_host_calls"], "Improvement host-call ceiling reached; stop instead of retrying")
                save(filename, request)
            require(read_json(filename) == request, "Immutable host request changed")
        response_path = self.session / "responses" / filename.name
        if not response_path.exists():
            raise Stop("needs-host")
        response = read_json(response_path)
        allowed = {"request_id", "request_fingerprint", "actor_context", "status", "cost_usd", "text", "harness", "outputs", "evidence", "trajectory", "model_id", "decision", "reason"}
        require(isinstance(response, dict) and not set(response) - allowed, "Unknown host response fields")
        require(all(response.get(key) == request[key] for key in ("request_id", "request_fingerprint", "actor_context")), "Host response identity differs from its request")
        require(response.get("status") == "completed", "Host execution failed or is incomplete; do not turn it into a successful improvement")
        cost = response.get("cost_usd")
        require(cost is None or isinstance(cost, (int, float)) and not isinstance(cost, bool) and math.isfinite(cost) and cost >= 0, "Invalid observed host cost")
        return response

    def pending(self):
        return [str(path) for path in sorted((self.session / "requests").glob("*.json")) if not (self.session / "responses" / path.name).exists()]


def run(job, state, upstream):
    require(job.get("version") == 1 and job.get("kind") == "hakengaisya-harness2-job", "Unsupported improvement job")
    require(job.get("upstream", {}).get("revision") == REVISION, "Unexpected upstream revision")
    policy = job["policy"]
    require(policy.get("enabled") is True and isinstance(policy.get("scope"), str) and policy["scope"], "Explicit project-scoped improvement is required")
    maximum = policy.get("max_host_calls")
    require(isinstance(maximum, int) and not isinstance(maximum, bool) and 1 <= maximum <= 12, "Invalid host-call ceiling")
    require(job["owner_context"] != job["supervisor_context"], "A worker cannot accept its own harness")
    require(job["evidence_kind"] in ("simulation", "local_work"), "Unknown improvement evidence kind")
    model = job["dispatch"]["model_binding"]
    require(model.get("model_id") and model.get("route"), "An explicit fixed execution model is required")
    base = job["base_harness"]
    require(set(base) == SURFACE and all(isinstance(value, str) for value in base.values()), "Unsupported base harness surface")
    job_hash = fingerprint(job)
    session = state / "sessions" / job_hash
    inspect_tree(state, bounded=False)
    session.mkdir(parents=True, exist_ok=True)
    input_path = session / "input.json"
    if input_path.exists():
        require(read_json(input_path) == job, "Cannot resume changed task inputs")
    else:
        save(input_path, job)
    if (session / "report.json").exists():
        return read_json(session / "report.json")
    host = Host(job, session)
    try:
        library, recursion, selection, tree, Reply, BenchPrompts, BenchSpec, ChannelSpec, RunView, OpencodeSubstrate = load_upstream(upstream)
        substrate = OpencodeSubstrate()
        profile = fingerprint({"scope": policy["scope"], "kind": job["evidence_kind"], "domain": job["domain"], "task_type": job["task_type"], "difficulty": job["difficulty"], "skills": sorted(job["skills"]), "required_tools": sorted(job["dispatch"].get("required_tools", [])), "model": {key: model.get(key) for key in ("model_id", "route", "effort")}})
        retained = library.Library(state / "library", profile, substrate.surface())
        library_input = session / "library-input"
        if not library_input.exists():
            library_input.mkdir()
            if retained.dir.exists():
                materialize(inspect_tree(retained.dir), library_input)
        materialize(base, session / "base")

        def validate_harness(harness):
            require(isinstance(harness, dict) and all(isinstance(name, str) and isinstance(value, str) for name, value in harness.items()), "A harness must be a text-file map")
            normalized = {name.replace("\\", "/"): value for name, value in harness.items()}
            require(len(normalized) == len(harness), "Duplicate normalized harness paths")
            harness.clear()
            harness.update(normalized)
            require(set(harness) == SURFACE and harness["guardrails.md"] == base["guardrails.md"], "Candidate changed a pinned component or executable surface")
            try:
                tree.validate(substrate.surface(), harness, allow_subagents=False)
            except ValueError as error:
                raise Stop("blocked", "Invalid candidate harness: " + str(error)) from None

        class Adapter:
            def __init__(self):
                self.substrate = substrate
                channel = ChannelSpec("opencode", "host/native")
                self.spec = BenchSpec(name="hakengaisya", runs_root=session, install_mode="workspace_config", prompts=BenchPrompts(work="complete the delegated technical work with inspectable deliverables"), channels={"proposer": channel, "selector": channel}, allow_subagents=False)

            def task_prompt(self, task_id):
                return canonical(job["dispatch"])

            def task_files(self, task_id):
                return None

            def base_harness(self):
                return session / "base"

            def validate_tree(self, harness):
                validate_harness(harness)

            def execute(self, task_id, harness_dir, run_id, **kwargs):
                harness = tree.read_tree(substrate.surface(), harness_dir or self.base_harness())
                validate_harness(harness)
                response = host.ask("execute", run_id, job["owner_context"], {"dispatch": job["dispatch"], "harness": harness, "isolated_workspace_required": True})
                require(response.get("model_id") == model["model_id"], "A probe silently switched the assigned model")
                outputs, evidence = response.get("outputs"), response.get("evidence")
                require(isinstance(outputs, list) and len(outputs) == len(job["dispatch"]["outputs"]) and {item.get("id") for item in outputs} == set(job["dispatch"]["outputs"]), "Probe must deliver exactly the contracted outputs")
                require(all(isinstance(item.get(key), str) and item[key].strip() for item in outputs for key in ("id", "reference", "summary", "text")), "Probe output needs inspectable references, summaries and readable contents")
                require(isinstance(evidence, list) and evidence and all(item.get("reference") and item.get("summary") for item in evidence), "Probe work evidence is required")
                require(isinstance(response.get("trajectory"), str) and response["trajectory"].strip(), "Probe trajectory is required")
                directory = session / "executions" / fingerprint(run_id)
                save(directory / "result.json", response)
                return directory

            def delivered(self, directory):
                return bool(read_json(directory / "result.json").get("outputs"))

            def trajectory(self, directory, **kwargs):
                return read_json(directory / "result.json")["trajectory"]

            def deliverable_files(self, directory):
                return {item["id"] + ".md": item["text"] for item in read_json(directory / "result.json")["outputs"]}

            def deliverable_text(self, directory):
                return "\n\n".join(self.deliverable_files(directory).values())

        class Proposer:
            def call(self, mission, context_dir, label, **kwargs):
                experience = label.startswith("experience.")
                response = host.ask("experience" if experience else "edit", label, job["supervisor_context"] if experience else job["owner_context"], {"mission": mission, "context": inspect_tree(Path(context_dir))})
                require(isinstance(response.get("text"), str) and response["text"].strip(), "Improvement reasoning is required")
                workspace = None
                if not experience:
                    validate_harness(response.get("harness", {}))
                    workspace = session / "edits" / fingerprint({"label": label, "context": inspect_tree(Path(context_dir))})
                    materialize(response["harness"], workspace)
                return Reply(label=label, text=response["text"], ok=True, cost_usd=response.get("cost_usd") or 0, attempts=1, cached=True, workspace=workspace, channel="hakengaisya-native-host")

        adapter, proposer = Adapter(), Proposer()
        task_id = job["job_id"]
        base_dir = adapter.execute(task_id, None, "base1")
        base_view = RunView(label="base1", run_id="base1", run_dir=base_dir, ok=True, delivered=True)
        result = recursion.run_parallel(task_id, 1, [base_view], adapter=adapter, prop=proposer, work_dir=session / "work", run_id_of=lambda label: label, base_tree=base, library_dir=library_input, propose_workers=1, rollout_workers=1)
        require(result.ok and not result.fell_back and all(view.ok and view.delivered for view in result.rollouts.values()), "Upstream refinement failed or fell back; stop before adoption")
        chosen = result.finals[0]
        review = host.ask("adoption-review", chosen, job["supervisor_context"], {"contract": job["dispatch"], "baseline": base, "candidate": result.trees[chosen], "rollouts": {label: read_json(view.run_dir / "result.json") for label, view in result.rollouts.items()}, "decision_required": "Accept or reject the candidate based on observed evidence; task acceptance remains separate."})
        require(review.get("decision") in ("accepted", "rejected") and isinstance(review.get("reason"), str) and review["reason"].strip() and review.get("evidence"), "A reasoned direct-supervisor adoption decision is required")
        report = {"version": 1, "job_id": job["job_id"], "job_fingerprint": job["job_fingerprint"], "evidence_kind": job["evidence_kind"], "upstream": job["upstream"], "profile_id": profile, "recursion_budget": 1, "supervisor_review": {"actor_context": job["supervisor_context"], "decision": review["decision"], "reason": review["reason"], "evidence": review["evidence"]}, "learned": False}
        if review["decision"] == "rejected":
            report["status"] = "rejected"
        else:
            adopted = selection.Selection(task_id=task_id, mode="agg", k=1, chosen_label=chosen, chosen_run_id=chosen, why=review["reason"], id_map={"A": chosen}, ok=True)
            experience = selection.reflect_adoption(task_id, adopted, result.rollouts, adapter=adapter, prop=proposer, work_dir=session / "work", decisions={stage.label: stage.notes for stage in result.stages})
            if library.has_experience(experience):
                retained.add(task_id, result.trees[chosen], why=review["reason"], label=chosen, run_id=task_id, experience=experience)
                report["learned"] = True
            delivery = read_json(result.rollouts[chosen].run_dir / "result.json")
            report.update(status="ready-for-submission", outputs=[{key: item[key] for key in ("id", "reference", "summary")} for item in delivery["outputs"]], evidence=delivery["evidence"], adopted_harness=str(session / "work/harnesses" / chosen), library_entries=len(retained.entries()))
        responses = [read_json(path) for path in (session / "responses").glob("*.json")]
        costs = [response.get("cost_usd") for response in responses]
        report.update(host_calls=len(list((session / "requests").glob("*.json"))), observed_cost_usd=sum(costs) if costs and all(cost is not None for cost in costs) else None, automatic_model_calls=False)
        save(session / "report.json", report)
        return report
    except Stop as stop:
        return {"status": stop.status, "reason": stop.reason, "job_id": job["job_id"], "session": str(session), "pending_requests": host.pending(), "response_directory": str(session / "responses"), "automatic_model_calls": False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job", required=True, type=Path)
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument("--upstream", type=Path)
    args = parser.parse_args(argv)
    require(sys.version_info[:2] in ((3, 12), (3, 13)), "Harness2 requires Python 3.12 or 3.13")
    state = args.state.resolve()
    state.mkdir(parents=True, exist_ok=True)
    inspect_tree(state, bounded=False)
    lock = state / "writer.lock"
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        raise Stop("blocked", "Another learning writer or a crash lock exists; inspect it before retrying") from None
    try:
        os.close(descriptor)
        with (state / "upstream-output.txt").open("w", encoding="utf-8") as log, contextlib.redirect_stdout(log):
            result = run(read_json(args.job), state, args.upstream)
    finally:
        lock.unlink()
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["status"] in ("needs-host", "ready-for-submission", "rejected") else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Stop as error:
        print(json.dumps({"status": error.status, "reason": error.reason, "automatic_model_calls": False}))
        sys.exit(1)
