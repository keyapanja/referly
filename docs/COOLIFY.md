# Deploying on Coolify (KVM VPS)

Step by step, from a fresh KVM virtual private server to a working install. Two applications (API and web) plus one Postgres database, all on one server, behind Coolify's own reverse proxy with automatic TLS.

Placeholders to replace throughout: `example.com` with your domain, and every value marked **you set this**.

## 1. The server

KVM is full virtualisation, so Docker runs without the restrictions of container-based virtualisation such as OpenVZ. Nothing special is needed beyond a clean Ubuntu install.

| Resource | Minimum | Comfortable |
|---|---|---|
| vCPU | 2 | 2 to 4 |
| RAM | 4 GB | 8 GB |
| Disk | 40 GB | 80 GB |

Memory is the one to get right. Coolify builds the web image on the same box, and a Next.js production build is the heaviest moment in the whole lifecycle. On 2 GB it can be killed part way through with no clear error. If you are on 2 GB, add swap before your first deploy:

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Install Coolify on a fresh Ubuntu 22.04 or 24.04:

```bash
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash
```

Then open `http://YOUR_SERVER_IP:8000`, create the admin account, and put the Coolify dashboard behind a domain of its own when you get a chance.

## 2. DNS

Point two records at the server before you deploy, so certificate issuing succeeds on the first try.

| Type | Name | Value |
|---|---|---|
| A | `app` | your server IP |
| A | `api` | your server IP |

Both must sit under **one** registrable domain. The browser session is an httpOnly, SameSite=Lax cookie set by the API, so `app.example.com` and `api.example.com` work, while two unrelated domains cannot sign anyone in.

## 3. Postgres

In your Coolify project: **New Resource**, **Database**, **PostgreSQL 16**. Give it a name, let Coolify generate the password, and deploy it.

Coolify shows an internal connection string of the form `postgres://postgres:PASSWORD@HOST:5432/postgres`. Copy it for the next step. Keep the database internal; it needs no public port.

## 4. The API application

**New Resource**, then **Private Repository** (or Public) pointing at this repository.

| Setting | Value |
|---|---|
| Build pack | Dockerfile |
| Dockerfile location | `apps/api/Dockerfile` |
| Base directory | `/` |
| Port | `4000` |
| Domain | `https://api.example.com` |
| Health check path | `/health/ready` |

Add a **persistent volume** mounted at `/app/data`. Uploaded assets and backup archives live there, and without it both are lost on every redeploy.

Environment variables:

```
NODE_ENV=production
DATABASE_URL=            # from step 3
BASE_URL=https://api.example.com
WEB_URL=https://app.example.com
TRUSTED_PROXY_HOPS=1
INTEGRATION_SECRET=      # you set this, 32+ random characters
BACKUP_KEY=              # you set this, 32+ random characters
METRICS_TOKEN=           # you set this
EMAIL_PROVIDER=resend    # or smtp
EMAIL_FROM=Referly <no-reply@example.com>
RESEND_API_KEY=          # you set this, with EMAIL_PROVIDER=resend
PLATFORM_ADMIN_EMAIL=you@example.com
PLATFORM_ADMIN_NAME=Your Name
PLATFORM_ADMIN_PASSWORD= # you set this
PLATFORM_SUPPORT_EMAIL=support@example.com
STORAGE_PROVIDER=local
```

Generate each secret on the server and paste it straight into Coolify:

```bash
openssl rand -base64 32
```

`TRUSTED_PROXY_HOPS=1` matters: Coolify runs Traefik in front of your app, and without it every rate limit and every click IP hash keys on the proxy rather than the visitor.

The API refuses to start in production without `INTEGRATION_SECRET` and a real `EMAIL_PROVIDER`. That is deliberate: the first encrypts payout credentials at rest, and the second means password resets and invitations actually reach people. Migrations run automatically on boot, so there is no separate migration step.

## 5. The web application

**New Resource**, same repository, second application.

| Setting | Value |
|---|---|
| Build pack | Dockerfile |
| Dockerfile location | `apps/web/Dockerfile` |
| Base directory | `/` |
| Port | `3000` |
| Domain | `https://app.example.com` |
| Health check path | `/login` |

One **build argument**, which is the single most common thing to get wrong here:

```
NEXT_PUBLIC_API_URL=https://api.example.com
```

It must be a build argument, not only a runtime variable. Next.js inlines it into the browser bundle at build time, so setting it at runtime leaves the deployed app calling `localhost:4000` from your visitors' browsers. Change the API domain later and you have to rebuild the web app, not just restart it.

## 6. Scale

Leave the API at **exactly one instance**. The background worker and the rate limiter both run inside the API process, so a second replica would send every scheduled email twice and take two backups a night. The web app can scale horizontally if you ever need it to.

## 7. First boot

1. Deploy the API, then the web app. Watch the API logs for `api_listening` and `platform_admin_ready`.
2. Open `https://app.example.com/login` and sign in with the platform admin address and password from step 4. You land on `/admin`.
3. Create your first merchant workspace by signing up at `https://app.example.com/signup` with a different email address. The platform admin account manages the platform; it does not run a programme itself.
4. Verify the email you receive. If nothing arrives, the delivery log on the workspace and the API logs both name the provider's response.
5. In the workspace, walk the quick path: create an offer, create a program, invite yourself as an affiliate from a third address, create a link in the portal, click it, and record a test conversion. That exercises tracking, attribution, commission and email in one pass.
6. Confirm the first backup on the admin overview after a day, and check `https://api.example.com/health/ready` returns `ok`.

## 8. After it is live

- **Backups.** The API takes an encrypted logical backup daily onto `/app/data`. That is on the same disk as the server, so also take Coolify's own volume backups to somewhere else, or set `STORAGE_PROVIDER=s3` and keep files off the box entirely. An archive is unreadable without `BACKUP_KEY`, so store that key with your passwords, not only in Coolify.
- **Restores.** Rehearse one before you need it. See [DEPLOYMENT.md](DEPLOYMENT.md).
- **Monitoring.** `GET /metrics` is Prometheus format behind `METRICS_TOKEN`. Alert on queue lag above 300 seconds, any dead job, and a worker heartbeat older than 60 seconds.
- **Errors.** Set `ERROR_REPORT_URL` to a Slack incoming webhook to get unhandled errors pushed to you.

## 9. When something does not work

| Symptom | Cause |
|---|---|
| Sign-in appears to succeed then bounces back to the login page | The app and API are not on the same parent domain, so the session cookie is rejected. |
| The browser calls `localhost:4000` in production | `NEXT_PUBLIC_API_URL` was set as a runtime variable rather than a build argument. Rebuild the web app. |
| The API container restarts in a loop | Read the first log lines. A missing `INTEGRATION_SECRET` or `EMAIL_PROVIDER` stops it deliberately. |
| The web build dies with no error | Out of memory. Add swap, as in step 1. |
| Every visitor shares one rate limit, and click IPs look identical | `TRUSTED_PROXY_HOPS` is unset. |
| Uploaded images vanish after a deploy | No persistent volume at `/app/data`. |
| Emails never arrive | Check `EMAIL_FROM` uses a domain you have verified with your provider. |
