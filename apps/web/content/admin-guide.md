# Platform admin guide

For the person running the platform itself, not a single workspace. You sign in with the platform admin account created from the environment on first boot.

## 1. What the admin surface is for

Sign in with the platform admin account (created from the environment on first boot) and you land on `/admin`: workspaces with usage, plan and custom limits, suspend, close (purged after the grace period) or reactivate, the operations panel (queue, webhooks, messages, backups, retention), dead jobs with retry.

Everything here is platform-wide. You never act inside a workspace's data: you manage the workspaces themselves, watch the machinery, and step in when a job or an integration fails.

## 2. Workspaces

**Tenants** lists every workspace with its plan, usage against its limits, and status.

- **Custom limits**: override any plan limit for one workspace, for example while a customer trials a bigger plan. A null limit means unlimited.
- **Suspend**: the workspace and its API keys stop working immediately, tracking links included. Use it for non-payment or abuse; it is reversible and destroys nothing.
- **Close**: the workspace is marked closed and is purged, with its uploaded files, after the grace period set by `TENANT_PURGE_DAYS`. Reopening before that cancels the purge.
- **Reactivate**: lifts a suspension.

## 3. Operations

The overview carries an operations panel: queue depth by status and type, queue lag, stuck jobs, dead outbound webhook deliveries, failed messages, the worker heartbeat, and when the last backup and retention run finished.

**Dead jobs** are jobs that exhausted their retries. Read the error, fix the cause, then retry from the Jobs page. A growing dead queue is the first sign that an integration's credentials have expired.

Alert on these from your monitoring rather than watching the page: queue lag over 300 seconds, any dead job, any stuck job, and a worker heartbeat older than 60 seconds. The same numbers are on `/metrics` in Prometheus format.

## 4. Backups and restores

A logical backup of the whole database plus uploaded files runs daily, encrypted, with daily-then-weekly rotation. The panel shows the age and size of the most recent one; you can trigger a run and download an archive.

Restoring is a command, not a button, and it replaces the contents of the target database: `npm run restore -- <key> --yes --files`. Rehearse it somewhere disposable before you ever need it in anger. Continuous integration rehearses it on every push, which is the only reason to trust it.

## 5. Retention and data requests

Each workspace sets its own retention for clicks, message logs, audit trail, webhook deliveries, automation runs, notifications, lead contact details and website journeys, within platform bounds. A nightly job prunes what has aged out. Financial records are never pruned.

Platform housekeeping, which no workspace controls, clears finished jobs, expired sessions, tokens and exports, and old maintenance history.

Erasure requests are carried out by the workspace's own team on their affiliate, not by you. Your part is making sure backups age out on their own schedule so an erasure is not silently undone by a restore.

## 6. When something is wrong

- **A workspace says tracking stopped**: check the workspace is active, then its programs and offers are active, then the queue.
- **Emails are not arriving**: check failed messages on the panel and the provider's own dashboard; the workspace's delivery log shows the provider response per message.
- **Webhooks stopped**: endpoints pause themselves after repeated failures and raise a task in the workspace. Redelivery is available from their log.
- **Everything is slow**: queue lag and stuck jobs first, then the database. The worker runs in the API process, so one instance only.

Every API error carries a request id, and every log line for that request has it too. Ask for the id first.
