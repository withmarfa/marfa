# Create a personal Marfa instance on Railway

Deploy Marfa on Railway to keep your instance running without a device hosting it. The template creates one server, a persistent data volume, and a private backup bucket in your Railway project. The server runs a released build: the published image `ghcr.io/withmarfa/marfa-server`, pinned to one version. Railway pulls that image and builds nothing from source.

## Deploy the template

You need a Railway account with permission to deploy services, volumes, and buckets in your chosen workspace. Railway bills the running service and storage to that workspace; see its [pricing documentation](https://docs.railway.com/pricing).

1. Open the [Marfa Railway template](https://railway.com/new/template/5z9-Ja).
2. Choose your workspace and create a project for this instance.
3. Review the resources: one Marfa server with a volume mounted at `/data`, and one private backup bucket belonging to this instance. Check that the server's image is a version tag, such as `ghcr.io/withmarfa/marfa-server:0.0.20`, and not `latest`. Deploy the resources together.
4. Wait for the server deployment to pass its `/health` check, then claim the instance below.
5. Note the release that is running. Run `curl https://<your-address>/`; the JSON answer names it as `release`. (A browser shows the page instead.) You need it to [update the server](#update-the-server) or go back to this build.

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

Enter your email and name in the command. The password uses a hidden prompt.

The browser handoff carries a single-use ticket in the URL fragment. Do not put a setup code in a URL or share the handoff link. The claim command must connect to the running server's local socket; `railway run` and `railway shell` run on your own machine and cannot reach it. See [Railway SSH](https://docs.railway.com/cli/ssh).

## Keep your instance recoverable

The `/data` volume holds the SQLite database and blob files. It persists through service restarts and redeployments. The container streams the database to the backup bucket with Litestream, and Marfa replicates blob files to that bucket separately. See [the deployment guide](README.md#what-runs-in-the-container) for the backup configuration.

The template also enables daily Railway volume backups, retained for six days. They cover the volume within the same project and environment. Wiping the volume deletes its snapshots; see [Railway volume backups](https://docs.railway.com/volumes/backups). **A volume backup is older than the backup bucket.** Replicating it would make the backup the bucket's newest copy of the database, and the writes made after the backup would survive only in older bucket history that expires, so the container does not start a volume backup with the bucket's current `S3_PREFIX`. Restore it as in [Restore a volume backup](#restore-a-volume-backup).

The volume is the working copy; the bucket is a separate recovery copy. Replication is asynchronous, so a bucket restore can miss recent changes or blobs that have not finished copying. A successful `/health` response does not prove that backup replication has completed. Railway's deployment health check also runs at startup rather than continuously; see [Railway health checks](https://docs.railway.com/deployments/healthchecks#continuous-healthchecks).

Preserve **`API_KEY_SALT` and `MARFA_AUTH_SECRET`** across restarts, redeployments, and restores. Keep a secure recovery copy outside the project. These values are not stored in the data volume or bucket: changing the salt invalidates existing API keys and app tokens, and losing the authentication secret ends existing browser sessions. If you seal Railway variables, save their recovery copies first, because [sealed values cannot be retrieved](https://docs.railway.com/variables#sealed-variables).

To recover a lost data volume, use the same image version, backup bucket, current `S3_PREFIX`, and secrets with a new volume. The container restores the database when none exists on the volume; Marfa can retrieve replicated blobs from the bucket and rebuild their disk copies. Follow [the deployment recovery instructions](README.md#restoring-by-hand). Keep the bucket while the instance or its recovery copy is needed. Railway does not currently provide automatic bucket snapshots; see [Storage Buckets](https://docs.railway.com/storage-buckets).

## Restore a volume backup

Restoring a Railway volume backup rolls the database back to the backup. Do the steps below so that the bucket keeps the writes made after the backup. [The deployment guide](README.md#restore-a-backup-that-is-older-than-the-bucket) explains why.

1. In the Marfa server's variables, change `S3_PREFIX` to a new value that this instance has never used, such as `restored/blobs`. Railway's [variables documentation](https://docs.railway.com/variables) says a variable change becomes a staged change that you must review and deploy.
2. Restore the backup as [Railway volume backups](https://docs.railway.com/volumes/backups) describes. Railway stages the restore, mounts a new volume at the same location as the original, and keeps the previous volume, unmounted.
3. Before you deploy, review the staged changes. Railway's [staged changes documentation](https://docs.railway.com/deployments/staged-changes) says that selecting **Deploy** deploys all of them at once, so check that the list shows both the variable change and the volume restore. If either is missing, do not deploy until it is staged.
4. After the deployment, open the deploy logs. Check that the `replicating to` line shows `path=` followed by the new prefix and `/db`, and that no `detected database behind replica` line appears. The logs also say that the entrypoint removed Litestream's record of the old prefix, `.marfa.db-litestream`, so that Litestream starts the new prefix from a snapshot of the database. If the logs instead say that the database may be older than the replica, the restore was deployed without the new `S3_PREFIX`: stage and deploy the variable change.

The old prefix keeps the newer history. **It also holds the database that names the files saved after the backup, and the bytes of those that had been copied to the bucket, none of which the restored instance can see**; [the deployment guide](README.md#what-the-steps-leave-behind) says how to read them. Keep the old prefix and the previous volume until you are sure you do not need them. Later recoveries use the new `S3_PREFIX`, and the container does not start the volume under the old prefix again while the old prefix holds a replica.

## Recover a forgotten password

1. Connect to the running Marfa server using its copied Railway SSH command.
2. Run the following inside the container:

   ```sh
   marfa --socket "$MARFA_CONTROL_SOCKET" owner recover
   ```

3. Enter the new password at the hidden prompt, then sign in with it.

Recovery ends existing browser sessions and preserves app access. It uses the same protected socket as claim. Keep the data volume and instance secrets in place throughout recovery.

## Update the server

Railway does not update this instance for you, and you should not let it update the image by itself. A new build updates the database in place at its first start, after it copies the database beside it on the volume, and going back to an earlier build means starting it on that copy; see [the deployment upgrade procedure](README.md#upgrading). Choose when that happens.

- **Template updates do not apply.** Railway [template updates](https://docs.railway.com/templates/updates) work only for services that come from a GitHub repository, and its documentation says there is no mechanism to check for updates to Docker images. Railway does not tell you that the template now names a newer version.
- **Leave image auto updates off.** Railway can [update an image automatically](https://docs.railway.com/deployments/image-auto-updates) inside a maintenance window. An automatic update redeploys the service with a newer image, which updates the database when you are not watching.
- **Keep the tag pinned.** A tag such as `latest` moves to each new release, so a redeploy or an image auto update can change the build under your database. A version tag does not move: the release workflow does not retag a version once published.

To move to a newer release:

1. Note the running release from `GET /`, and take a volume backup as [Railway volume backups](https://docs.railway.com/volumes/backups) describes.
2. In the Marfa server's settings, change the source image's tag to the new release, such as `ghcr.io/withmarfa/marfa-server:<release>`, then review and deploy the staged change.
3. In the deployment's logs, find the line that says the server updated the database and names the copy, then read `GET /health`.

If the new build refuses the database, it changed nothing: set the tag back to the previous release and deploy. Railway's rollback changes the deployment, not the database contents, so once the new build has updated the database, setting the tag back alone runs the previous release on a database it may refuse or not fully know. To go back after an update, restore the volume backup from step 1, which is older than the bucket's copy, as [Restore a volume backup](#restore-a-volume-backup) says, with the tag set back to the previous release in the same deployment.

## Remove your instance

Before removal, export any data you want to keep and verify that the archive unpacks. Keep the running build's release and instance secrets if you need to restore it later; see [the deployment upgrade procedure](README.md#upgrading).

For a project created only for this instance:

1. Download any bucket objects you want to retain. Open the **Backups** bucket, select **Settings**, and choose **Delete Bucket**. Deploy the staged deletion; see [bucket deletion](https://docs.railway.com/storage-buckets#deleting-a-bucket).
2. Open the project's **Settings**, select **Danger**, and choose **Delete Project**. This removes the project's services, environments, and deployments; see [project deletion](https://docs.railway.com/projects#deleting-a-project).
3. Return to the workspace dashboard and confirm that the instance project is gone.

To keep the backup bucket for recovery, keep its project and delete only the Marfa service and its data volume. If the project also hosts other services, remove only this instance's service, volume, and bucket. Storage that you retain continues to be billed.

## Template configuration

These settings describe the saved template and its container defaults.

| Setting                     | Value                                                                         |
| --------------------------- | ----------------------------------------------------------------------------- |
| Server source               | Docker image `ghcr.io/withmarfa/marfa-server:<version>`, a pinned release tag |
| Volume mount                | `/data`                                                                       |
| `SQLITE_PATH`               | `/data/marfa.db`                                                              |
| `BLOB_PATH`                 | `/data/blobs`                                                                 |
| `NODE_ENV`                  | `production` (set by the container)                                           |
| Runtime UID                 | `RAILWAY_RUN_UID=0`                                                           |
| Control socket              | `/data/control/marfa.sock` (`MARFA_CONTROL_SOCKET`, set by the image)         |
| Shutdown allowance          | `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`                                      |
| Client address header       | `TRUSTED_PROXY_HEADER=x-real-ip`                                              |
| Volume backup schedule      | Daily                                                                         |
| HTTP port and domain target | `8600`                                                                        |
| Health check                | `/health`                                                                     |
| Replicas                    | `1`                                                                           |
| Serverless                  | Disabled                                                                      |
| Image auto updates          | Off                                                                           |
| `API_KEY_SALT`              | `${{secret(64, "abcdef0123456789")}}`                                         |
| `MARFA_AUTH_SECRET`         | `${{secret(64, "abcdef0123456789")}}`                                         |
| `MARFA_AUTH_BASE_URL`       | `https://${{RAILWAY_PUBLIC_DOMAIN}}`                                          |
| `S3_BUCKET`                 | Reference to the backup bucket's `BUCKET`                                     |
| `S3_REGION`                 | Reference to the backup bucket's `REGION`                                     |
| `S3_ENDPOINT`               | Reference to the backup bucket's `ENDPOINT`                                   |
| `S3_ACCESS_KEY_ID`          | Reference to the backup bucket's `ACCESS_KEY_ID`                              |
| `S3_SECRET_ACCESS_KEY`      | Reference to the backup bucket's `SECRET_ACCESS_KEY`                          |
| `S3_FORCE_PATH_STYLE`       | `false` for newly created Railway buckets                                     |
| `S3_PREFIX`                 | `blobs`                                                                       |

Railway's [bucket reference variables](https://docs.railway.com/storage-buckets#railway-provided-variables) use `BUCKET` for the S3 name; the display name is different. New buckets use virtual-hosted URLs. Older buckets may require path-style URLs, as shown in their Credentials tab. Each instance needs its own bucket, including separate instances created from the same template.

The image names its own build, so the template sets no build variable. `GET /` answers the commit the image was built from as `version` and the release as `release`, and `/health` reports the commit. Each tag is published for `linux/amd64` and `linux/arm64`, and a published version tag is never moved. The package is public, so Railway pulls it without registry credentials.

Railway mounts volumes as root. The template uses Railway's `RAILWAY_RUN_UID=0` override so the server and command share an OS account that can write the fresh volume. The local socket remains private inside the container; see [volume permissions](https://docs.railway.com/volumes#permissions). Keep the image public: [template images with hidden registry credentials disable SSH](https://docs.railway.com/templates/create#private-docker-images) and stop people from changing the image source, and claiming and recovering the instance need SSH.
