# BreadSheet - Social Food Rating App

**BreadSheet** is a cross-platform mobile application built with Expo and React Native that allows users to rate food products, scan barcodes to retrieve details, and share their culinary discoveries within private groups.

## Contents

- [Key Features](#key-features)
- [Tech Stack](#-tech-stack)
- [Getting Started](#-getting-started)
- [Configuration Reference](#configuration-reference)
- [Optional / Advanced Setup](#optional--advanced-setup)
- [Running on Windows](#running-on-windows)
- [Troubleshooting](#troubleshooting)

## Key Features

* **Rate by Taste:** Simple, intuitive interface to rate food based on taste (0–10, 0.5-step precision).
* **Scan & Discover:** Integrated barcode scanner (EAN/UPC) to instantly find products or fetch metadata via Open Food Facts.
* **Add Products:** Crowdsource the database with a camera-assisted flow — capture the product and nutritional label, let on-device OCR pre-fill the details, then submit for peer review.
* **Social Groups:** Create groups (e.g., "Office Snacks", "Family Dinners") to share ratings and recommendations specifically with them.
* **History:** Keep a personal log of everything you've tasted.

## 🛠 Tech Stack

### Frontend (Mobile)

* **Framework:** [Expo](https://expo.dev/) (React Native)
* **Navigation:** React Navigation (Stack & Tabs)
* **State Management:** React Context (session, recently viewed products)
* **Scanning:** `expo-camera`

### Backend (API)

* **Runtime:** Node.js
* **Framework:** Express.js
* **Database:** PostgreSQL
* **ORM:** Prisma
* **Authentication:** Supabase Auth
* **External Data:** Open Food Facts API
* **Infrastructure:** Kubernetes (Amazon EKS), AWS RDS, Terraform, ArgoCD, Google Vision and Gemini
* **Local Dev:** Docker Compose / Podman, LocalStack (for AWS service emulation)

## 🚀 Getting Started

> **Platform:** these instructions target **Linux with Podman** (the primary development setup). The command blocks use `docker compose`; on Podman, substitute `podman compose` — everything else is identical. macOS works the same way with Docker Desktop. For Windows, see [Running on Windows](#running-on-windows).

### Prerequisites

* **Node.js v24** with npm
* **Podman** (or Docker) with the Compose plugin
* **Podman only:** enable the user socket once — LocalStack needs it to run the image-resizer Lambda:
    ```sh
    systemctl --user enable --now podman.socket
    ```
* A free [Supabase](https://supabase.com) project (for auth)
* For the mobile app: the **Expo Go** app on a physical device, or an emulator

### 1. Clone the repository

```sh
git clone <repo-url> && cd bread-sheet
```

### 2. Install dependencies

```sh
# Frontend
cd bread-sheet-app && npm install && cd ..

# Backend
cd server && npm install && cd ..
```

For the full **Add Product** flow (camera capture, on-device OCR, image processing) you also need native modules:
```sh
cd bread-sheet-app
npx expo install expo-image-picker expo-image-manipulator
npm install @react-native-ml-kit/text-recognition
cd ..
```
These are loaded via guarded `require()` in `features/products/`, so tests and the sign-up/sign-in flows work without them — but the capture/OCR/processing steps won't run until they're installed and the native client is rebuilt (Expo Go is not sufficient; use a dev build).

### 3. Configure environment variables

Create a Supabase project, then copy its **Project URL** and **anon/public key** from **Project Settings → API**, and enable **anonymous sign-in** for the project.

Each package ships an `.env.example` — copy and fill in the placeholders:

```sh
cp server/.env.example server/.env
cp bread-sheet-app/.env.example bread-sheet-app/.env
cp .env.example .env          # root — LocalStack token + ADC mount path
```

See the [Configuration Reference](#configuration-reference) for what every variable does.

### 4. Start the backend stack

From the project root:

```sh
# Build the image-resizer Lambda bundle (LocalStack deploys it on startup)
cd server/lambda/imageResizer && npm install && npm run build && cd ../../..

# Podman only: pre-pull the Lambda runtime image once, so LocalStack doesn't
# stall trying to pull it through the compat socket (see Troubleshooting).
podman pull public.ecr.aws/lambda/nodejs:24

# Start PostgreSQL + LocalStack in the background
docker compose up -d

# Initialize the database (apply migrations)
cd server && npm run db:deploy && cd ..
```

The LocalStack init hook (`scripts/localstack-init.sh`) provisions the S3 bucket, the image-resizer Lambda, and the S3→Lambda trigger automatically on startup. Verify it ran:

```sh
docker compose logs localstack | grep '\[init\]'
```

You should see lines for the bucket, Lambda, and trigger. If something is missing, see [Troubleshooting](#troubleshooting).

### 5. Run the server and app

Run the **server** on the host (recommended — fastest hot-reload, and ADC credentials are discovered automatically):

```sh
cd server && npm run dev          # http://localhost:3000
```

> Alternatively, run the server in a container with `docker compose --profile app-dev up -d --build`. This bind-mounts your host ADC file for Gemini/Vision — see the [ADC mount note](#optional--advanced-setup).

Run the **app**:

```sh
cd bread-sheet-app && npx expo start
```

Scan the QR code with Expo Go (or press `a`/`i` for an emulator).

## Configuration Reference

### `server/.env` — backend API

| Variable | Description |
|----------|-------------|
| `PORT` | Port the Express server listens on (default `3000`) |
| `NODE_ENV` | Runtime environment (`development` / `production` / `test`) |
| `DATABASE_URL` | PostgreSQL connection string — matches the Docker Compose service |
| `SUPABASE_URL` | Your Supabase project URL (Project Settings → API) |
| `SUPABASE_PUBLISHABLE_DEFAULT_KEY` | Supabase anon/public key (same settings page) |
| `AWS_ENDPOINT_URL` | LocalStack endpoint for S3/Lambda emulation (`http://localhost:4566` locally) — SDK only |
| `S3_BUCKET_NAME` | S3 bucket where product images are stored |
| `S3_MODE` | S3 backend: `localstack` (path-style addressing, required by LocalStack) or `aws` (SDK default) — **required, no default** |
| `ASSET_BASE_URL` | Public base URL where stored image keys resolve, including the bucket part (e.g. `http://<your-LAN-ip>:4566/breadsheet-images-local` locally — must be reachable from the device running the app, so use the same host as `EXPO_PUBLIC_API_URL`) — **required, no default** |
| `VISION_MODE` | OCR backend: `mock` (fixture), `live` (Google Vision), `llm` (Gemini) — **required, no default** |
| `PLAUSIBILITY_MODE` | Upload image plausibility / abuse gate: `mock` (accept all) or `gemini` (real AI check) — **required, no default** |
| `GOOGLE_GENAI_USE_VERTEXAI` | `true` to authenticate Gemini via Vertex AI + ADC (recommended; no API key). Requires `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`. Leave unset to use `GEMINI_API_KEY` instead. |
| `GOOGLE_CLOUD_PROJECT` | GCP project ID for Vertex AI (when `GOOGLE_GENAI_USE_VERTEXAI=true`) |
| `GOOGLE_CLOUD_LOCATION` | Vertex AI location — `global`, or a region like `europe-west4` for data residency (when `GOOGLE_GENAI_USE_VERTEXAI=true`) |
| `GEMINI_API_KEY` | Gemini **Developer API** key from Google AI Studio — the alternative to Vertex. Required when `VISION_MODE=llm` or `PLAUSIBILITY_MODE=gemini` **and** `GOOGLE_GENAI_USE_VERTEXAI` is not `true` |
| `APP_DEEP_LINK_SCHEME` | Deep-link scheme for the `/auth/callback` redirect (`exp+breadsheet` for Expo Go, `breadsheet` for a production build) |
| `LOG_LEVEL` | Winston log verbosity (`error` / `warn` / `info` / `debug` / …) |

### `bread-sheet-app/.env` — Expo frontend

| Variable | Description |
|----------|-------------|
| `EXPO_PUBLIC_SUPABASE_URL` | Same Supabase project URL as the server |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` | Same Supabase anon/public key |
| `EXPO_PUBLIC_API_URL` | Base URL the app uses to reach the backend (e.g. your LAN IP + port when running locally) |
| `EXPO_PUBLIC_AUTH_REDIRECT_URL` | Server `/auth/callback` URL Supabase redirects to after email verification. Must be reachable from the device and added to Supabase → Authentication → URL Configuration → Redirect URLs |

### `.env` — root (Docker Compose / LocalStack)

| Variable | Description |
|----------|-------------|
| `LOCALSTACK_AUTH_TOKEN` | Auth token for the LocalStack Pro container |
| `GCLOUD_ADC_PATH` | Host path to your Google ADC file, bind-mounted into the `app-dev` server container. Linux/macOS: `${HOME}/.config/gcloud/application_default_credentials.json`; Windows: `${APPDATA}/gcloud/application_default_credentials.json` |

## Optional / Advanced Setup

### Google Cloud Vision (`VISION_MODE=live`)

By default `VISION_MODE=mock` returns a fixed sample response for any label image — no GCP credentials needed. To test against the real Vision API:

1. **Install the Google Cloud SDK** — [cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)
2. **Create local Application Default Credentials (ADC)** on the **host**:
    ```sh
    gcloud auth application-default login
    ```
    Credentials are written to `~/.config/gcloud/application_default_credentials.json` and picked up automatically by the server running on the host — no `GOOGLE_APPLICATION_CREDENTIALS` env var needed locally.
3. **Enable the Vision API:**
    ```sh
    gcloud services enable vision.googleapis.com --project=YOUR_PROJECT_ID
    ```
4. **Grant your account the Vision User role:**
    ```sh
    gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
      --member="user:your-email@example.com" \
      --role="roles/cloudvision.user"
    ```
5. **Switch the mode** in `server/.env`: `VISION_MODE=live`

### Image plausibility / abuse gate (`PLAUSIBILITY_MODE=gemini`)

The Add Product flow runs an AI check on every uploaded image (TICKET-P5-005): it rejects non-product / unusable photos with actionable feedback, reads front-of-pack name/brand suggestions, and flags abusive content. With `PLAUSIBILITY_MODE=mock` (the `.env.example` default) every image is accepted without inspection. To run the real check, set `PLAUSIBILITY_MODE=gemini` and pick **one** auth method (both are read by the shared `getGeminiClient()` factory — the app code is identical):

**Option A — Vertex AI via ADC (recommended, no API key).** Reuses Application Default Credentials, so if you already set up `VISION_MODE=live`, the same `gcloud auth application-default login` covers Gemini too:

1. Enable the API: `gcloud services enable aiplatform.googleapis.com --project=YOUR_PROJECT_ID`
2. Grant the role (skip if you are Owner/Editor):
    ```sh
    gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
      --member="user:your-email@example.com" \
      --role="roles/aiplatform.user"
    ```
3. Point ADC quota at this project (Vertex requires billing enabled):
    ```sh
    gcloud auth application-default set-quota-project YOUR_PROJECT_ID
    ```
4. Set in `server/.env` (leave `GEMINI_API_KEY` unset):
    ```env
    PLAUSIBILITY_MODE=gemini
    GOOGLE_GENAI_USE_VERTEXAI=true
    GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID
    GOOGLE_CLOUD_LOCATION=global
    ```

**Option B — Gemini Developer API key (simplest, but a long-lived secret).** Create a key at [Google AI Studio](https://aistudio.google.com/apikey) (free tier; no GCP project/billing required), then in `server/.env`:
```env
PLAUSIBILITY_MODE=gemini
GEMINI_API_KEY=your-key            # leave GOOGLE_GENAI_USE_VERTEXAI unset
```

#### Running the server in a container with Vertex/ADC

Running the server on the **host** (`npm run dev`) discovers ADC automatically and needs nothing extra. The `app-dev` **container** instead bind-mounts the host ADC file, controlled by `GCLOUD_ADC_PATH` in the root `.env` (see [Configuration Reference](#env--root-docker-compose--localstack)):

```yaml
# docker-compose.yml
- ${GCLOUD_ADC_PATH}:/root/.config/gcloud/application_default_credentials.json:ro
```

Verify the mount after `docker compose --profile app-dev up`:
```sh
docker compose exec server cat /root/.config/gcloud/application_default_credentials.json
```
Non-empty JSON means ADC is available inside the container.

### Terraform against LocalStack

Terraform is the source of truth for **AWS** infrastructure. For local development you do **not** need Terraform — the LocalStack init hook provisions the bucket, Lambda, and S3 trigger on `docker compose up`. To apply the Terraform config against LocalStack anyway (e.g. to test the Terraform code itself):

1. Build the Lambda first: `cd server/lambda/imageResizer && npm run build`
2. `cd terraform && terraform init`
3. `terraform apply -var-file=environments/local.tfvars --auto-approve`

Keep the Lambda runtime in `scripts/localstack-init.sh` in sync with `terraform/lambda.tf`.

### Production credentials (Workload Identity Federation)

In production, Vertex AI is the only Gemini path (`GOOGLE_GENAI_USE_VERTEXAI=true`) and Vision uses `live`. Both resolve ADC through **Workload Identity Federation** — `GOOGLE_APPLICATION_CREDENTIALS` points at a WIF credential config file mounted via a Kubernetes ConfigMap, and the service account needs `roles/cloudvision.user` + `roles/aiplatform.user`. No service-account JSON key or `GEMINI_API_KEY` is stored anywhere. See `docs/server-production.md`.

## Running on Windows

The project is developed on Linux/Podman, but it runs on Windows with Docker too. Use a **native Windows terminal (PowerShell or CMD)** — not WSL2 — and adapt as follows:

- **Compose runtime:** use Docker Desktop (`docker compose`). The Compose stack interpolates Windows host paths and environment variables that only resolve in a native Windows shell.
- **Copying env files:** replace `cp` with `Copy-Item`, e.g. `Copy-Item server/.env.example server/.env`.
- **ADC mount path:** set `GCLOUD_ADC_PATH` in the root `.env` to `${APPDATA}/gcloud/application_default_credentials.json`. `${APPDATA}` only resolves in PowerShell/CMD — from a WSL2 shell it is undefined and the mount silently fails, breaking Gemini/Vision auth in the container.
- **Multi-line `gcloud` commands:** use a backtick (`` ` ``) for line continuation instead of the `\` shown above, or put each command on one line.

> **Why not WSL2?** Expo needs to detect your host network interface to serve the dev bundle to devices/emulators, and the Compose stack relies on Windows-path mounts (the ADC file). Both break under WSL2. If you specifically want WSL2, run `gcloud` inside WSL and set `GCLOUD_ADC_PATH` to the Linux ADC path instead.

## Troubleshooting

**A port isn't reachable from your phone or another device (firewall).** This applies to *any* port the device must reach — the Expo/Metro bundler (**8081**), the API server (**3000**), and the LocalStack asset host in `ASSET_BASE_URL` (**4566**). On Linux a firewall (ufw/firewalld) blocks incoming connections by default. For each affected port:

1. Confirm the service listens on all interfaces, not just localhost — `ss -tlnp | grep <port>` should show `*:<port>` or `0.0.0.0:<port>`. A `127.0.0.1:<port>` bind is only reachable from the PC itself.
2. Allow the port for your LAN, e.g. with ufw (substitute the port):
    ```sh
    sudo ufw allow from 192.168.0.0/16 to any port 3000 proto tcp
    ```

Also ensure the device and PC are on the same network, and that `EXPO_PUBLIC_API_URL` / `ASSET_BASE_URL` use the PC's LAN IP (not `localhost`). As a firewall-free fallback for the bundler, `npx expo start --tunnel` routes through ngrok.

**LocalStack init hook fails with `PermissionError: [Errno 13] Permission denied`.** LocalStack *executes* the mounted init script, so it must be executable (Podman passes the missing exec bit through faithfully). The bucket, Lambda, and trigger are then never created. Fix once:
```sh
chmod +x scripts/localstack-init.sh
docker compose restart localstack
```

**The init hook hangs for ~5 minutes, then fails at the Lambda step (Podman).** Symptom: the script creates the bucket but the Lambda stays `Pending`, the `lambda wait function-active-v2` waiter times out, and the hook exits 255. Cause: to activate a Lambda, LocalStack pulls the runtime image (`public.ecr.aws/lambda/nodejs:24`) through Podman's Docker-compatible socket, whose `/images/create` pull endpoint can stall indefinitely — even though the Podman CLI pulls the same image fine. Pre-pull it with the Podman CLI so LocalStack finds it cached:
```sh
podman pull public.ecr.aws/lambda/nodejs:24
docker compose restart localstack
```
This is a one-time step (it's also in [Start the backend stack](#4-start-the-backend-stack)). The image stays cached until you prune Podman images or `LAMBDA_RUNTIME` in `scripts/localstack-init.sh` bumps to a newer version.

**Image uploads work but images are never resized (no `processed/` objects).** The init hook logged `WARNING: ... index.js not found` because the Lambda bundle wasn't built before `docker compose up`, so the Lambda was skipped. Build it, then redeploy:
```sh
cd server/lambda/imageResizer && npm run build && cd ../../..
docker compose restart localstack
```
The same two commands redeploy the Lambda whenever you change its code.

**Server crashes at startup with `Missing required environment variable: ...`.** Config is validated fail-fast (no silent defaults). Set the named variable in `server/.env` — see the [Configuration Reference](#serverenv--backend-api) — and restart. If running in a container, recreate it so the new `.env` is read: `docker compose --profile app-dev up -d server`.