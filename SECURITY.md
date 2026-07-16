# Security policy

## Supported use

meme-ify is designed for one trusted user on `127.0.0.1`. It is not hardened
as an internet-facing service and has no user-account or authorization layer.

Do not expose the Vite server through a public tunnel, reverse proxy, shared
host, or container port. The local middleware can read and write application
state, proxy requests through configured API credentials, and optionally run a
locally authenticated Claude CLI process.

## Wallet safety

- The app never asks for or stores a seed phrase or private key.
- Phantom displays and signs each live transaction.
- Verify the mint, input amount, expected output, route, slippage, and price
  impact in Phantom before approving.
- Use a separate low-balance wallet for experiments.
- Treat every upstream quote, token audit, and price as untrusted input.

## Secrets and local data

Store secrets only in `.env.local`, which is ignored by Git. Database dumps,
trade exports, generated assets, and logs may contain sensitive activity and
must not be committed. Run a history-aware secret scanner before publishing a
fork or accepting a contribution containing configuration changes.

The optional Claude endpoint is disabled unless `ENABLE_LOCAL_CLAUDE=true`.
Enabling it permits prompts from the local browser to consume the credentials
and quota of the locally installed Claude CLI.

## Reporting a vulnerability

Please open a private security advisory in the Git hosting provider rather
than filing a public issue. Include the affected revision, reproduction steps,
impact, and any suggested mitigation. Do not include wallet secrets, API keys,
database contents, or seed phrases.
