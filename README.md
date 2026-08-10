# BreadSheet - Social Food Rating App

**BreadSheet** is a cross-platform mobile application built with Expo and React Native that allows users to rate food products, scan barcodes to retrieve details, and share their culinary discoveries within private groups.

## Contents

- [Key Features](#key-features)
- [Tech Stack](#-tech-stack)
- [Getting Started](#-getting-started)
- [Optional / Advanced Setup](#optional--advanced-setup)
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
* **Infrastructure:** AWS ECS Fargate (dev) behind an ALB, AWS RDS, S3, SSM, Terraform, GitHub-Actions push-CD, Google Vision and Gemini (keyless via Workload Identity Federation)
* **Local Dev:** Docker Compose / Podman, LocalStack (for AWS service emulation)

## 🚀 Getting Started

> **Platform:** these instructions target **Linux with Podman** (the primary development setup). The command blocks use `docker compose`; on Podman, substitute `podman compose` — everything else is identical. macOS works the same way with Docker Desktop. For Windows, see [`docs/architecture/infrastructure.md`](docs/architecture/infrastructure.md) § Local Development.

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

`@react-native-async-storage/async-storage` is a regular dependency (installed by `npm install` above) and is **not** optional: it backs Supabase session persistence, so without a native rebuild after adding it, users are signed out on every cold start.

### 3. Configure environment variables

Two things need setting up before the placeholders below will work:

* **Supabase project** — create one, then copy its **Project URL** and **anon/public key** from **Project Settings → API**, and enable **anonymous sign-in** for the project.
* **LocalStack auth token** — grab one from your [LocalStack account](https://app.localstack.cloud/) (needed to run Lambda emulation for local image processing).

Each package ships an `.env.example` with the rest of the variables explained inline — copy and fill in the placeholders:

```sh
cp server/.env.example server/.env
cp bread-sheet-app/.env.example bread-sheet-app/.env
cp .env.example .env          # root — LocalStack token + ADC mount path
```

### 4. Start the backend stack

From the project root:

```sh
# Build the image-resizer Lambda bundle (LocalStack deploys it on startup)
cd server/lambda/imageResizer && npm install && npm run build && cd ../../..

# Podman only: pre-pull the Lambda runtime image once, so LocalStack doesn't
# stall trying to pull it through the compat socket (see Troubleshooting).
podman pull public.ecr.aws/lambda/nodejs:24

# Start PostgreSQL + LocalStack in the background
podman compose up -d

# Initialize the database (apply migrations)
cd server && npm run db:deploy && cd ..
```

The LocalStack init hook (`scripts/localstack-init.sh`) provisions the S3 bucket, the image-resizer Lambda, and the S3→Lambda trigger automatically on startup. Verify it ran:

```sh
podman compose logs localstack | grep '\[init\]'
```

You should see lines for the bucket, Lambda, and trigger. If something is missing, see [Troubleshooting](#troubleshooting).

### 5. Run the server and app

Run the **server** on the host (recommended — fastest hot-reload, and ADC credentials are discovered automatically):

```sh
cd server && npm run dev          # http://localhost:3000
```

> Alternatively, run the server in a container with `docker compose --profile app-dev up -d --build`. This bind-mounts your host ADC file for Gemini/Vision — see [Live Google Vision / Gemini](#live-google-vision--gemini-and-running-on-windows) below.

Run the **app**:

```sh
cd bread-sheet-app && npx expo start
```

Scan the QR code with Expo Go (or press `a`/`i` for an emulator).

Run the app's E2E tests (Playwright, against Expo web — see [Agentic Dev Team](#agentic-dev-team)):

```sh
cd bread-sheet-app && npx playwright install chromium   # one-time
npm run test:e2e
```

## Optional / Advanced Setup

### Agentic Dev Team

`FEATURES.md` tickets are implemented by a small team of coding agents (frontend / backend /
reviewer) rather than by hand — `/dev-team <TICKET-ID>` (Claude Code) or `npm run dev-team --
<TICKET-ID>` (standalone Mastra harness, `agent-team/`). See
[`docs/architecture/agent-dev-team.md`](docs/architecture/agent-dev-team.md) for setup and the full
contract.

### Building an Android APK

An installable `.apk` is built via EAS Build (`.github/workflows/build-apk.yml`, manually triggered)
because the app ships native modules that don't run in plain Expo Go. One-time setup required before
it can run. See [`docs/architecture/infrastructure.md`](docs/architecture/infrastructure.md) §
Mobile App Build (Android APK).

### Live Google Vision / Gemini, and running on Windows

By default `VISION_MODE=mock` and `PLAUSIBILITY_MODE=mock` return fixture data, so nothing below is
needed to just run the app. For switching to the real Vision/Gemini APIs locally (ADC setup, IAM
roles, the two Gemini auth options, and mounting ADC into the `app-dev` container), production
credentials via Workload Identity Federation, and Windows-specific setup steps, see
[`docs/architecture/infrastructure.md`](docs/architecture/infrastructure.md) § Local Development.

### Deploy to AWS (dev environment)

Deploys to the dev **ECS Fargate** environment are automatic on merge to `main` — nothing to run
locally. See [`docs/architecture/infrastructure.md`](docs/architecture/infrastructure.md) §
Deployment Pipeline.

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

**Server crashes at startup with `Missing required environment variable: ...`.** Config is validated fail-fast (no silent defaults). Set the named variable in `server/.env` — see the comments in `server/.env.example` for what it expects — and restart. If running in a container, recreate it so the new `.env` is read: `docker compose --profile app-dev up -d server`.