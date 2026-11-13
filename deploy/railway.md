# Create a personal Marfa instance on Railway

Deploy Marfa on Railway to keep your instance running without a device hosting it. The template creates one server and a persistent data volume in your Railway project. The server runs a released build: the published image `ghcr.io/withmarfa/marfa-server`, pinned to one version. Railway pulls that image and builds nothing from source. Railway provides the HTTPS address, because the server doesn't terminate TLS itself. This page does not cover backups to a bucket.

## Deploy the template

You need a Railway account with permission to deploy services and volumes in your chosen workspace. Railway bills the running service and storage to that workspace; see its [pricing documentation](https://docs.railway.com/pricing).

1. Open the [Marfa Railway template](https://railway.com/new/template/5z9-Ja).
2. Choose your workspace and create a project for this instance.
3. Review the resources: one Marfa server with a volume mounted at `/data`. Check that the server's image is a version tag, such as `ghcr.io/withmarfa/marfa-server:0.0.70`, and not `latest`. Deploy.
4. Wait for the server deployment to pass its `/health` check, then claim the instance below.
5. Note the release that is running. Run `curl https://<your-address>/`; the JSON answer names it as `version`. (A browser shows the page instead.) You need it to [update the server](#update-the-server) or go back to this build.

The template generates separate random values for `MARFA_KEY_SALT` and `MARFA_AUTH_SECRET` for each deployment, so you don't generate secrets yourself. Railway documents this under [template variable functions](https://docs.railway.com/templates/create#template-variable-functions).

Keep the server at **one replica**, with **Serverless disabled**. The instance uses one SQLite database, and its background work needs to keep running.

## Claim your instance

Claim and recovery commands run inside the deployed server through Railway SSH. They use Marfa's protected local control socket. The image has no shell, so each command is passed to `railway ssh` after `--` rather than typed into a session, and paths are written out in full.

1. Install the [Railway CLI](https://docs.railway.com/cli#installing-the-cli), sign in with `railway login`, and link a folder to the project with `railway link`. Register an SSH key if Railway prompts you to do so.
2. Find the server's public domain in its **Settings**, such as `marfa-production.up.railway.app`.
3. For browser setup, run the following and open the link it prints:

   ```sh
   railway ssh -- marfa --socket /data/control/marfa.sock setup open --address https://<your-domain> --no-browser
   ```

4. Create your owner account in that browser window.

To set up entirely in the terminal, replace step 3 with:

```sh
railway ssh -- marfa --socket /data/control/marfa.sock setup claim --address https://<your-domain> --email you@example.com --name "Your name"
```

Enter your email and name in the command. The password uses a hidden prompt.

`--address` sets the address people sign in at, before the link or the owner is made. A passkey is bound to that address, so it must be the exact HTTPS address you use. If you add a custom domain, claim with that domain instead: `--address https://marfa.example.com`.

The browser handoff carries a single-use ticket in the URL fragment. Do not put a setup code in a URL or share the handoff link. The claim command must connect to the running server's local socket; `railway run` and `railway shell` run on your own machine and cannot reach it. See [Railway SSH](https://docs.railway.com/cli/ssh).

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

1. From the folder you linked with `railway link`, run:

   ```sh
   railway ssh -- marfa --socket /data/control/marfa.sock owner recover
   ```

2. Enter the new password at the hidden prompt, then sign in with it.

Recovery ends existing browser sessions and preserves app access. It uses the same protected socket as claim. Keep the data volume and instance secrets in place throughout recovery.

## Update the server

Railway does not update this instance for you, and you should not let it update the image by itself. A new build can update the database in place at its first start, after it copies the database beside it on the volume; see [Upgrade](README.md#upgrade). Choose when that happens.

- **Template updates do not apply.** Railway [template updates](https://docs.railway.com/templates/updates) work only for services that come from a GitHub repository, and its documentation says there is no mechanism to check for updates to Docker images. Railway does not tell you that the template now names a newer version.
- **Leave image auto updates off.** Railway can [update an image automatically](https://docs.railway.com/deployments/image-auto-updates) inside a maintenance window. An automatic update redeploys the service with a newer image, which can update the database when you are not watching.
- **Keep the tag pinned.** A tag such as `latest` moves to each new release, so a redeploy or an image auto update can change the build under your database. A version tag does not move: the release workflow does not retag a version once published.

To move to a newer release:

1. Note the running release from `version` in `GET /`, and take a volume backup as [Railway volume backups](https://docs.railway.com/volumes/backups) describes.
2. In the Marfa server's settings, change the source image's tag to the new release, such as `ghcr.io/withmarfa/marfa-server:<release>`, then review and deploy the staged change.
3. Read `GET /health`. If the release changed the database schema, the deployment's logs record the copy the server made, `/data/marfa.db.before-upgrade`. A release with the same schema makes no copy.

If the new build refuses a database that a newer build wrote, or one whose schema matches none it knows, the server exits with status 78 and changes nothing. Its supervisor keeps the container running but unhealthy: set the tag back to the previous release and deploy. If the volume lacks the free space for the copy, the server exits with status 1 and changes nothing, and Railway restarts it to the same refusal until there's room. Railway's rollback changes the deployment, not the database contents, so once the new build has updated the database, setting the tag back alone runs the previous release on a database it refuses. To go back after an update, restore the volume backup from step 1 as [Restore a volume backup](#restore-a-volume-backup) says, with the tag set back to the previous release in the same deployment.

The copy the server made stays on the volume, as large as the data in the database, until the next upgrade replaces it. Delete it once you won't go back; [Upgrade](README.md#upgrade) says more.

## Remove your instance

Before removal, export any data you want to keep and verify that the archive unpacks. Keep the running build's release and instance secrets if you need to restore it later.

For a project created only for this instance:

1. Open the project's **Settings**, select **Danger**, and choose **Delete Project**. This removes the project's services, environments and deployments; see [project deletion](https://docs.railway.com/projects#deleting-a-project).
2. Return to the workspace dashboard and confirm that the instance project is gone.

If the project also hosts other services, remove only this instance's service and its volume. Storage that you retain continues to be billed.

## Template configuration

These settings describe the saved template and its container defaults. [Settings](README.md#settings) describes each name.

| Setting                     | Value                                                                         |
| --------------------------- | ----------------------------------------------------------------------------- |
| Server source               | Docker image `ghcr.io/withmarfa/marfa-server:<version>`, a pinned release tag |
| Volume mount                | `/data`                                                                       |
| `MARFA_DATABASE_PATH`       | `/data/marfa.db` (set by the image)                                           |
| `MARFA_BLOB_PATH`           | `/data/blobs` (set by the image)                                              |
| Control socket              | `/data/control/marfa.sock` (`MARFA_CONTROL_SOCKET`, set by the image)         |
| Runtime UID                 | `RAILWAY_RUN_UID=0`                                                           |
| Shutdown allowance          | `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`                                      |
| Client address header       | `MARFA_TRUSTED_PROXY_HEADER=x-real-ip`                                        |
| Volume backup schedule      | Daily                                                                         |
| HTTP port and domain target | `8600`                                                                        |
| Health check                | `/health`                                                                     |
| Replicas                    | `1`                                                                           |
| Serverless                  | Disabled                                                                      |
| Image auto updates          | Off                                                                           |
| `MARFA_KEY_SALT`            | `${{secret(64, "abcdef0123456789")}}`                                         |
| `MARFA_AUTH_SECRET`         | `${{secret(64, "abcdef0123456789")}}`                                         |

The image names its own build: `GET /` answers the release as `version`. Each tag is published for `linux/amd64` and `linux/arm64`, and a published version tag is never moved. The package is public, so Railway pulls it without registry credentials.

Railway mounts volumes as root. The image runs as user 65532, which can't write a fresh volume, so the template uses Railway's `RAILWAY_RUN_UID=0` override so that the server and the claim command share an OS account that can write it. The local socket remains private inside the container; see [volume permissions](https://docs.railway.com/volumes#permissions). Keep the image public: [template images with hidden registry credentials disable SSH](https://docs.railway.com/templates/create#private-docker-images) and stop people from changing the image source, and claiming and recovering the instance need SSH.
