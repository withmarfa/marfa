# Create a personal Marfa instance on Railway

Deploy Marfa on Railway to keep your instance running without a device hosting it. The template creates one server, a persistent data volume, and a private backup bucket in your Railway project.

**Container-tested; Railway verification pending.** Live deployment, claim, and recovery checks remain outstanding.

## Deploy the template

You need a Railway account with permission to deploy services, volumes, and buckets in your chosen workspace. Railway bills the running service and storage to that workspace; see its [pricing documentation](https://docs.railway.com/pricing).

1. Open the [Marfa Railway template](https://railway.com/new/template/5z9-Ja).
2. Choose your workspace and create a project for this instance.
3. Review the resources: one Marfa server with a volume mounted at `/data`, and one private backup bucket belonging to this instance. Deploy them together.
4. Wait for the server deployment to pass its `/health` check, then claim the instance below.

The template generates separate random values for `API_KEY_SALT` and `MARFA_AUTH_SECRET` for each deployment. It also references the new bucket's credentials and sets `MARFA_AUTH_BASE_URL` to the server's public HTTPS address. You should not need to enter bucket credentials or generate secrets yourself. Railway documents these mechanisms under [template variable functions](https://docs.railway.com/templates/create#template-variable-functions) and [variable references](https://docs.railway.com/variables#reference-variables).

Keep the server at **one replica**, with **Serverless disabled**. The instance uses one SQLite database, and its background backup and housekeeping processes need to keep running.

## Claim your instance

Claim and recovery commands run inside the deployed server through Railway SSH. They use Marfa's protected local control socket.

1. Install the [Railway CLI](https://docs.railway.com/cli#installing-the-cli) and sign in with `railway login`.
2. In the Railway dashboard, right-click the Marfa server and select **Copy SSH Command**. Run that command in your terminal. Register an SSH key if Railway prompts you to do so.
3. For browser setup, run the following inside the container and open the link it prints:

   ```sh
   marfa --socket "$MARFA_CONTROL_SOCKET" setup open --no-browser
   ```

4. Create your owner account in that browser window.

To set up entirely in the terminal, replace step 3 with:

```sh
marfa --socket "$MARFA_CONTROL_SOCKET" setup claim --email you@example.com --name "Your name"
```

Enter your email and name in the command. The password uses a hidden prompt. **Pending: verify these commands in the deployed container.**

The browser handoff carries a single-use ticket in the URL fragment. Do not put a setup code in a URL or share the handoff link. The claim command must connect to the running server's local socket; `railway run` and `railway shell` run on your own machine and cannot reach it. See [Railway SSH](https://docs.railway.com/cli/ssh).

## Keep your instance recoverable

The `/data` volume holds the SQLite database and blob files. It persists through service restarts and redeployments. The container streams the database to the backup bucket with Litestream, and Marfa replicates blob files to that bucket separately. See [the deployment guide](README.md#what-runs-in-the-container) for the backup configuration.

The template also enables daily Railway volume backups, retained for six days. They cover the volume within the same project and environment. Wiping the volume deletes its snapshots; see [Railway volume backups](https://docs.railway.com/volumes/backups).

The volume is the working copy; the bucket is a separate recovery copy. Replication is asynchronous, so a bucket restore can miss recent changes or blobs that have not finished copying. A successful `/health` response does not prove that backup replication has completed. Railway's deployment health check also runs at startup rather than continuously; see [Railway health checks](https://docs.railway.com/deployments/healthchecks#continuous-healthchecks).

Preserve **`API_KEY_SALT` and `MARFA_AUTH_SECRET`** across restarts, redeployments, and restores. Keep a secure recovery copy outside the project. These values are not stored in the data volume or bucket: changing the salt invalidates existing API keys and app tokens, and losing the authentication secret ends existing browser sessions. If you seal Railway variables, save their recovery copies first, because [sealed values cannot be retrieved](https://docs.railway.com/variables#sealed-variables).

To recover a lost data volume, use the same container revision, backup bucket, and secrets with a new volume. The container restores the database when none exists on the volume; Marfa can retrieve replicated blobs from the bucket and rebuild their disk copies. Follow [the deployment recovery instructions](README.md#restoring-by-hand). Keep the bucket while the instance or its recovery copy is needed. Railway does not currently provide automatic bucket snapshots; see [Storage Buckets](https://docs.railway.com/storage-buckets).

## Recover a forgotten password

1. Connect to the running Marfa server using its copied Railway SSH command.
2. Run the following inside the container:

   ```sh
   marfa --socket "$MARFA_CONTROL_SOCKET" owner recover
   ```

3. Enter the new password at the hidden prompt, then sign in with it.

**Pending: verify recovery, ended browser sessions, and preserved app access on Railway.**

Recovery ends existing browser sessions and preserves app access. It uses the same protected socket as claim. Keep the data volume and instance secrets in place throughout recovery.

## Update the server

Railway [template updates](https://docs.railway.com/templates/updates) are opt-in. Review an update before applying it. Record the running container revision before an update. A redeploy preserves the volume, but a new build can refuse a database whose schema differs from its own. Before the first public release, cross-build archive compatibility is also not guaranteed.

Follow [the deployment upgrade procedure](README.md#upgrading): export with the running build, start the new build on a fresh volume and a new bucket, then restore the archive. Keep the old instance and export until the restore succeeds. Railway's rollback changes the deployment, not the database contents, so retain the build that can read your existing database.

## Remove your instance

Before removal, export any data you want to keep and verify that the archive unpacks. Keep the running build and instance secrets if you need to restore it later; see [the deployment upgrade procedure](README.md#upgrading).

For a project created only for this instance:

1. Download any bucket objects you want to retain. Open the **Backups** bucket, select **Settings**, and choose **Delete Bucket**. Deploy the staged deletion; see [bucket deletion](https://docs.railway.com/storage-buckets#deleting-a-bucket).
2. Open the project's **Settings**, select **Danger**, and choose **Delete Project**. This removes the project's services, environments, and deployments; see [project deletion](https://docs.railway.com/projects#deleting-a-project).
3. Return to the workspace dashboard and confirm that the instance project is gone.

To keep the backup bucket for recovery, keep its project and delete only the Marfa service and its data volume. If the project also hosts other services, remove only this instance's service, volume, and bucket. Storage that you retain continues to be billed.

## Template configuration

These are the intended settings for template maintenance. Verify them against the finished template before publishing this guide.

| Setting                     | Value                                                |
| --------------------------- | ---------------------------------------------------- |
| Server source               | `withmarfa/marfa`, default branch                    |
| Volume mount                | `/data`                                              |
| `SQLITE_PATH`               | `/data/marfa.db`                                     |
| `BLOB_PATH`                 | `/data/blobs`                                        |
| `NODE_ENV`                  | `production` (set by the container)                  |
| Dockerfile                  | `deploy/Dockerfile` via `RAILWAY_DOCKERFILE_PATH`    |
| Build revision              | `VERSION_SHA=${{RAILWAY_GIT_COMMIT_SHA}}`            |
| Runtime UID                 | `RAILWAY_RUN_UID=0`                                  |
| Control socket              | `/run/marfa/control.sock`                            |
| Shutdown allowance          | `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`             |
| Client address header       | `TRUSTED_PROXY_HEADER=x-real-ip`                     |
| Volume backup schedule      | Daily                                                |
| HTTP port and domain target | `8600`                                               |
| Health check                | `/health`                                            |
| Replicas                    | `1`                                                  |
| Serverless                  | Disabled                                             |
| `API_KEY_SALT`              | `${{secret(64, "abcdef0123456789")}}`                |
| `MARFA_AUTH_SECRET`         | `${{secret(64, "abcdef0123456789")}}`                |
| `MARFA_AUTH_BASE_URL`       | `https://${{RAILWAY_PUBLIC_DOMAIN}}`                 |
| `S3_BUCKET`                 | Reference to the backup bucket's `BUCKET`            |
| `S3_REGION`                 | Reference to the backup bucket's `REGION`            |
| `S3_ENDPOINT`               | Reference to the backup bucket's `ENDPOINT`          |
| `S3_ACCESS_KEY_ID`          | Reference to the backup bucket's `ACCESS_KEY_ID`     |
| `S3_SECRET_ACCESS_KEY`      | Reference to the backup bucket's `SECRET_ACCESS_KEY` |
| `S3_FORCE_PATH_STYLE`       | `false` for newly created Railway buckets            |
| `S3_PREFIX`                 | `blobs`                                              |

Railway's [bucket reference variables](https://docs.railway.com/storage-buckets#railway-provided-variables) use `BUCKET` for the S3 name; the display name is different. New buckets use virtual-hosted URLs. Older buckets may require path-style URLs, as shown in their Credentials tab. Each instance needs its own bucket, including separate instances created from the same template.

Railway mounts volumes as root. The template uses Railway's `RAILWAY_RUN_UID=0` override so the server and command share an OS account that can write the fresh volume. The local socket remains private inside the container; see [volume permissions](https://docs.railway.com/volumes#permissions). The selected source must also allow SSH: [private template images with hidden registry credentials disable SSH](https://docs.railway.com/templates/create#private-docker-images).
