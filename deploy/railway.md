# Create a personal Marfa instance on Railway

Deploy Marfa on Railway to keep your instance running without a device hosting it. The template creates one server and a persistent data volume in your Railway project. The server runs a released build: the published image `ghcr.io/withmarfa/marfa-server`. The template follows `latest`, so a new deployment starts on the newest release, and you then pin your instance to that release. Railway pulls that image and builds nothing from source. Railway provides the HTTPS address, because the server doesn't terminate TLS itself. This page does not cover backups to a bucket.

## Deploy the template

You need a Railway account with permission to deploy services and volumes in your chosen workspace. Railway bills the running service and storage to that workspace; see its [pricing documentation](https://docs.railway.com/pricing).

1. Open the [Marfa Railway template](https://railway.com/new/template/5z9-Ja).
2. Choose your workspace and create a project for this instance.
3. Review the resources: one Marfa server, with the image `ghcr.io/withmarfa/marfa-server:latest` and a volume mounted at `/data`. Then deploy.
4. Wait for the server deployment to pass its `/health` check.
5. Find the release that is running. Run `curl https://<your-address>/`; the JSON answer names it as `version`. (A browser shows the page instead.)
6. Pin the instance to that release: in the server's **Settings**, change the image to `ghcr.io/withmarfa/marfa-server:<version>`, with the version from the previous step, and deploy. A later deployment then can't move your database to a newer release by itself (see [Choose a release](#choose-a-release)).
7. Claim the instance below.

The template generates separate random values for `MARFA_KEY_SALT` and `MARFA_AUTH_SECRET` for each deployment, so you don't generate secrets yourself. Railway documents this under [template variable functions](https://docs.railway.com/templates/create#template-variable-functions).

Keep the server at **one replica**, with **Serverless disabled**. The instance uses one SQLite database, and its background work needs to keep running.

## Claim your instance

Railway gives the server no shell, so you claim it from a browser with a setup code that the server prints in its log. The template sets `MARFA_CLAIM_ADDRESS` to the server's public Railway address, which is the address people sign in at.

1. In the server's **Deployments** tab, open the deploy logs and find the line `Claim this Marfa at https://<your-address>/setup with setup code: <code>`.
2. Open that address and enter the setup code.
3. Create your owner account.

A restart that happens before you claim prints a new setup code. A passkey is bound to the sign-in address, so if you add a custom domain, set `MARFA_CLAIM_ADDRESS` to it, for example `https://marfa.example.com`, and deploy before you claim. After the instance has an owner, `MARFA_CLAIM_ADDRESS` no longer changes anything.

## Keep your instance recoverable

The `/data` volume holds the SQLite database, the files and the private control socket. It persists through service restarts and redeployments. The template also enables daily Railway volume backups, retained for six days. They cover the volume within the same project and environment. Wiping the volume deletes its snapshots; see [Railway volume backups](https://docs.railway.com/volumes/backups).

Preserve **`MARFA_KEY_SALT` and `MARFA_AUTH_SECRET`** across restarts, redeployments and restores. Keep a secure recovery copy outside the project. These values are not stored in the data volume: changing the salt invalidates existing API keys and app tokens, and changing the authentication secret ends existing browser sessions. If you seal Railway variables, save their recovery copies first, because [sealed values cannot be retrieved](https://docs.railway.com/variables#sealed-variables).

## Restore a volume backup

Restoring a Railway volume backup rolls the database and the files back to the backup. Writes made after it are gone.

1. Restore the backup as [Railway volume backups](https://docs.railway.com/volumes/backups) describes. Railway stages the restore, mounts a new volume at the same location as the original, and keeps the previous volume, unmounted.
2. Review the staged changes and select **Deploy**. Railway's [staged changes documentation](https://docs.railway.com/deployments/staged-changes) says that it deploys all of them at once.
3. Keep the same image version and the same `MARFA_KEY_SALT` and `MARFA_AUTH_SECRET`, then read `GET /health`.

Keep the previous volume until you are sure you don't need it.

## Recover a forgotten password

Recovery changes the owner's password and ends browser sessions. Keys and approved apps keep working.

1. In the server's **Variables** tab, set `MARFA_OWNER_RECOVERY` to `true` and deploy.
2. In the deploy logs, find the line `Recover this Marfa's owner at https://<your-address>/setup with recovery code: <code>`. The code works once and for 60 minutes, and each start prints a new one.
3. Open that address, enter the recovery code and choose a new password.
4. Delete `MARFA_OWNER_RECOVERY` and deploy again, so that the server stops printing recovery codes.

Anyone who can read the project's deploy logs can use a recovery code, so leave the setting on only while you recover.

## Choose a release

Railway does not update this instance for you, and you should not let it update the image by itself. Keep the image tag pinned to the release you deployed, and change it only to upgrade.

Before Marfa 0.1, a newer release may not read an earlier release's database. To upgrade, set the image tag to the newer release and deploy. A release that can't read the database changes nothing in it, says why in the deploy logs, and doesn't start. Set the tag back to the earlier release and deploy again. Then move by export and restore: export the data while the earlier release runs, create a new project from the template with the newer release, and restore the archive there. A release that changes how the database is laid out keeps a copy of it first, as `marfa.db.before-upgrade` in the `/data` volume. To go back to an earlier release, set its tag and deploy; it refuses a database it can't read in the same way.

- **Template updates do not apply.** Railway [template updates](https://docs.railway.com/templates/updates) work only for services that come from a GitHub repository, and its documentation says there is no mechanism to check for updates to Docker images.
- **Leave image auto updates off.** Railway can [update an image automatically](https://docs.railway.com/deployments/image-auto-updates) inside a maintenance window, which would put a newer build on your database.
- **Keep the tag pinned.** `latest`, which the template starts from, moves to each new release. A version tag does not move: the release workflow does not retag a version once published.

## Remove your instance

Before removal, export any data you want to keep and verify that the archive unpacks. Keep the running build's release and instance secrets if you need to restore it later.

For a project created only for this instance:

1. Open the project's **Settings**, select **Danger**, and choose **Delete Project**. This removes the project's services, environments and deployments; see [project deletion](https://docs.railway.com/projects#deleting-a-project).
2. Return to the workspace dashboard and confirm that the instance project is gone.

If the project also hosts other services, remove only this instance's service and its volume. Storage that you retain continues to be billed.

## Template configuration

Check these settings before deploying. [Settings](README.md#settings) describes each name.

| Setting                      | Value                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| Server source                | Docker image `ghcr.io/withmarfa/marfa-server:latest`, pinned to its release after the first deployment |
| Volume mount                 | `/data`                                                                                                |
| `MARFA_DATABASE_PATH`        | `/data/marfa.db` (set by the image)                                                                    |
| `MARFA_BLOB_PATH`            | `/data/blobs` (set by the image)                                                                       |
| Control socket               | `/data/control/marfa.sock` (`MARFA_CONTROL_SOCKET`, set by the image)                                  |
| `PORT`                       | `8600` (Railway's health check reads it; the server does not)                                          |
| Runtime UID                  | `RAILWAY_RUN_UID=0`                                                                                    |
| Shutdown allowance           | `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`                                                               |
| Client address header        | `MARFA_TRUSTED_PROXY_HEADER=x-real-ip`                                                                 |
| Ranges the header comes from | `MARFA_TRUSTED_PROXY_CIDRS=0.0.0.0/0,::/0`                                                             |
| Sign-in address              | `MARFA_CLAIM_ADDRESS=https://${{RAILWAY_PUBLIC_DOMAIN}}`                                               |
| Volume backup schedule       | Daily                                                                                                  |
| HTTP port and domain target  | `8600`                                                                                                 |
| Health check                 | `/health`                                                                                              |
| Replicas                     | `1`                                                                                                    |
| Serverless                   | Disabled                                                                                               |
| Image auto updates           | Off                                                                                                    |
| `MARFA_KEY_SALT`             | `${{secret(64, "abcdef0123456789")}}`                                                                  |
| `MARFA_AUTH_SECRET`          | `${{secret(64, "abcdef0123456789")}}`                                                                  |

Railway's edge connects from addresses that Railway doesn't publish, so the template believes the client address header from every address, including another service in the same project that reaches the instance on the private network.

The image names its own build: `GET /` answers the release as `version`. Each tag is published for `linux/amd64` and `linux/arm64`, and a published version tag is never moved. The package is public, so Railway pulls it without registry credentials.

Railway mounts volumes as root. The image runs as user 65532, which can't write a fresh volume, so the template uses Railway's `RAILWAY_RUN_UID=0` override. See [volume permissions](https://docs.railway.com/volumes#permissions). Keep the image public: [template images with hidden registry credentials disable SSH](https://docs.railway.com/templates/create#private-docker-images) and stop people from changing the image source.
