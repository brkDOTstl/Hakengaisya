# Deployment

## Native process

```powershell
npm run example
$env:EVALUATOR_WITH_LOCAL_HISTORY = '1'
npm start
```

The optional environment switch loads the curated historical credibility seed. Without it, the server starts with neutral reviewer weights. The example database still displays its stored historical profiles in either mode.

Defaults: host `127.0.0.1`, port `4317`, data directory `.data`. Override with `EVALUATOR_HOST`, `EVALUATOR_PORT`, and `EVALUATOR_DATA_DIR`. Configuration contains no API keys. Back up the SQLite database using a consistent SQLite backup or stop the process before copying its data directory; copying only the main file while WAL writes are active is insufficient.

## Container

```text
docker compose up --build -d
```

The image runs as the non-root Node user and uses a named volume for SQLite state. Compose exposes only loopback on the host. Docker execution was not verified on the initial author machine because no Docker CLI was available.

To host the website, place the service behind an HTTPS reverse proxy with request-size, timeout, and rate limits, and terminate TLS there. Configure the public domain and enrollment policy before opening network access. Never expose the development database or private signing keys as static files. Keep the data volume outside the checkout's publishable content.

The SDK refuses remote plaintext HTTP and redirected uploads. It accepts loopback HTTP for local development. The public source repository does not run this backend or serve a public deployment automatically.

## Agent enrollment

The agent host creates and retains an Ed25519 private key in its own credential store. Provide only its public key to the operator. Enroll through `scripts/enroll.ts`, binding an opaque client and installation collection to one reviewer model. Client disabling is supported by `Store.disable`; a remote enrollment or moderation interface is deliberately absent in this first release.

## Validation

Run `npm test`, `npm run audit`, and `npm run example`. The example performs actual signed HTTP submissions, SQL persistence, and profile readback. It does not invoke a paid model API. Tests supply synthetic observations for capability/cost decisions and label them accordingly.

CI is configured for Node 24 on Windows and Linux. Only a completed CI run verifies those remote runner environments; passing tests on the author machine do not establish that result.
