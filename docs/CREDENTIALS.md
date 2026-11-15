# Credentials

NullNode needs exactly **one** credential to place calls nobody else can read:
a Cloudflare API token for the signalling relay. The website itself needs none.
Everything below is copy-paste-able, and every secret is revocable in one click.

| # | Credential | Needed for | Where it comes from | Scope |
|---|---|---|---|---|
| 1 | `CLOUDFLARE_API_TOKEN` | deploying the Worker relay | Cloudflare dashboard → My Profile → API Tokens | Account · **Workers Scripts: Edit** + Account · **Account Settings: Read** |
| 2 | `CLOUDFLARE_ACCOUNT_ID` | telling wrangler which account | Cloudflare dashboard url or zone overview | not a secret, but required |
| 3 | `GITHUB_TOKEN` *(optional)* | non-interactive Pages deploy | `gh auth login`, or a PAT | `repo`, `workflow` (+ `Pages: write`, `Administration: write` on fine-grained tokens) |

Nothing else. No database, no TURN key, no OAuth app, no cookie secret, no
analytics key, no third-party API. If a guide tells you otherwise, it is a
different project.

---

## 1 · Cloudflare API token (relay)

**Create it**

1. Sign in at <https://dash.cloudflare.com> (free plan is enough — Workers
   includes 100k requests/day and the Durable Object free tier covers
   thousands of two-person calls).
2. Top-right avatar → **My Profile** → **API Tokens** → **Create Token**.
3. Choose the template **“Edit Cloudflare Workers”**, or **Create Custom Token**
   with these two permissions:

   | Type | Permission | Access |
   |---|---|---|
   | Account | Workers Scripts | **Edit** |
   | Account | Account Settings | **Read** |

   Account Resources: **include → your account**.
   Zone Resources: leave empty (NullNode needs no zone, no DNS record).
4. Create token, copy the value **once**. It looks like
   `v1.0-…` and is 40-ish characters.

**Find your account id**

- The 32-hex string in the dashboard url: `dash.cloudflare.com/<ACCOUNT_ID>/…`
- Or any zone → **Overview** → right column → *Account ID*.
- Or `curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
   https://api.cloudflare.com/client/v4/accounts | jq -r '.result[0].id'`

**Verify the token before deploying**

```bash
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  https://api.cloudflare.com/client/v4/user/tokens/verify | jq .result.status
# → "active"
```

**Use it**

```bash
export CLOUDFLARE_API_TOKEN="v1.0-…"
export CLOUDFLARE_ACCOUNT_ID="0123456789abcdef0123456789abcdef"
./scripts/deploy-worker.sh
```

or put both lines in `deploy.env` (git-ignored, template in
`deploy.env.example`) and the script picks them up.

**In CI** — add them as repository secrets so `.github/workflows/relay.yml` can
deploy on demand:

```bash
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
```

**Revoke** — same page, *Delete*. Nothing in the running site breaks until the
relay is redeployed; airgap mode keeps working regardless.

---

## 2 · GitHub token (site)

`gh auth login` is enough for a person at a keyboard: the script uses whatever
`gh` is already authenticated with.

For automation, create a token with:

| Token type | Scopes |
|---|---|
| Classic PAT | `repo`, `workflow` |
| Fine-grained | **Contents**: Read and write · **Workflows**: Read and write · **Pages**: Read and write · **Administration**: Read and write |

`Administration: write` is only used to switch Pages on
(`POST /repos/:owner/:repo/pages`). If you would rather not hand that over,
enable Pages once by hand:

> Settings → Pages → **Build and deployment** → Source: **GitHub Actions**

and the deploy script will skip that step from then on.

`Workflows: write` is needed because the repository ships
`.github/workflows/pages.yml`; a token without it cannot push workflow files.

---

## 3 · What NullNode deliberately does *not* need

| Not needed | Why |
|---|---|
| Database / KV / R2 | rooms live in memory until the last peer leaves |
| TURN secret | media is peer-to-peer; a TURN relay would break the privacy claim |
| Signing key / JWT secret | there is no session, no identity, no cookie |
| Analytics token | there is no telemetry in the page |
| OAuth client | there is no login |

---

## 4 · Error decoder

| Message | Meaning | Fix |
|---|---|---|
| `Authentication error [code: 10000]` | token invalid, expired or wrong account | recreate the token, check `CLOUDFLARE_ACCOUNT_ID` |
| `10000: Authentication error` on deploy | token lacks **Workers Scripts: Edit** | edit token permissions |
| `You do not have permission to access this resource` | account id belongs to another account | use the id that owns the worker |
| `A worker with this name already exists` | first deploy of a same-named script | rename with `CLOUDFLARE_WORKER_NAME=…` |
| `Resource not accessible by integration` (GitHub) | token cannot manage Pages/Actions | add the scopes above, or enable Pages by hand |
| `fatal: refusing to allow a ... workflow` | token missing `workflow` scope | add scope, or push from an account that has it |

---

## 5 · Handling secrets

- `deploy.env`, `.env` and `.dev.vars` are git-ignored. Keep them that way.
- The deploy script never writes a token to disk, never echoes it (only the
  first 6 and last 4 characters as a fingerprint), and never logs it in CI
  (`::add-mask::` is applied by GitHub for repository secrets automatically).
- Rotate after sharing a screen or a shell history. Both tokens are one-click
  revocable and cost nothing.
