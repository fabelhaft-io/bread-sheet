# BreadSheet - Social Food Rating App

**BreadSheet** is a cross-platform mobile application built with Expo and React Native that allows users to rate food products, scan barcodes to retrieve details, and share their culinary discoveries within private groups.

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
* **Infrastructure:** Kubernetes (Amazon EKS), AWS Database, Terraform, ArgoCD
* **Local Dev:** Docker Compose, LocalStack (for AWS service emulation)

## 🚀 Getting Started

### Prerequisites

* Server and App: Node.js (v24) with npm, and docker
* App: Expo Go app on your physical device (iOS/Android) or an Emulator.
* Infrastructure: Terraform

### Local Installation

## Development Environment

This project runs on Windows; use a **native Windows terminal (PowerShell or CMD)** for both parts:

| Part | Recommendations                                                                       |
|------|---------------------------------------------------------------------------------------|
| `server/` — Node.js API + Docker | **Native Windows** (PowerShell / CMD)                                                                              |
| `bread-sheet-app/` — Expo / React Native | **Native Windows** (PowerShell / CMD) |

### Why native Windows for the Expo app?

Expo needs to detect your local network interface to serve the dev bundle to physical devices or emulators. Running from WSL2 can cause network discovery issues (wrong IP, unreachable Metro server). Use a native Windows terminal here.

### Why native Windows for the server and Docker?

The Docker Compose stack relies on **Windows host paths and environment variables** that only resolve in a Windows shell. The `app-dev` profile bind-mounts the Google ADC credentials file from `${APPDATA}\gcloud\...`; `APPDATA` is undefined in a WSL2/Linux shell, so the mount silently fails and Gemini/Vision auth breaks inside the container. Run `docker compose` from PowerShell or CMD so env-var interpolation and Windows-path mounts work.

> WSL2 was previously recommended here for bind-mount performance, but it breaks Windows-path mounts like the ADC file. If you specifically want WSL2, run `gcloud` inside WSL and repoint the mount in `docker-compose.yml` at the Linux ADC path — otherwise stick to PowerShell.


1. **Clone the repository**
2. **Install React App Dependencies**

    ```powershell
    cd bread-sheet-app
    npm install
    ```

    For the Add Product flow (TICKET-P5-002) you'll additionally need:
    ```powershell
    npx expo install expo-image-picker expo-image-manipulator
    npm install @react-native-ml-kit/text-recognition
    ```
    These native dependencies are loaded via guarded `require()` in `features/products/`, so tests and the sign-up/sign-in flows work without them — but the camera capture, on-device OCR, and image processing won't run until they're installed and the native client is rebuilt (Expo Go is not sufficient; use a dev build).

3. **Install Server Dependencies**

    ```powershell
    cd ../server
    npm install
    ```

4. **Environment Setup**

    This project requires a [Supabase](https://supabase.com) project for authentication. Create a free project at supabase.com, then find your **Project URL** and **anon/public key** under **Project Settings → API**. Additionally enable anonymous login for the project.

    Each package ships an `.env.example` file — copy it and fill in the placeholders:

    ```powershell
    Copy-Item server/.env.example server/.env
    Copy-Item bread-sheet-app/.env.example bread-sheet-app/.env
    Copy-Item .env.example .env          # root — LocalStack auth token
    ```

    **`server/.env`** — backend API:

    | Variable | Description |
    |----------|-------------|
    | `PORT` | Port the Express server listens on (default `3000`) |
    | `NODE_ENV` | Runtime environment (`development` / `production` / `test`) |
    | `DATABASE_URL` | PostgreSQL connection string — matches the Docker Compose service |
    | `SUPABASE_URL` | Your Supabase project URL (Project Settings → API) |
    | `SUPABASE_PUBLISHABLE_DEFAULT_KEY` | Supabase anon/public key (same settings page) |
    | `AWS_ENDPOINT_URL` | LocalStack endpoint for S3/Lambda emulation (`http://localhost:4566` locally) |
    | `S3_BUCKET_NAME` | S3 bucket where product images are stored |
    | `VISION_MODE` | OCR backend: `mock` (fixture), `live` (Google Vision), `llm` (Gemini) — **required, no default** |
    | `PLAUSIBILITY_MODE` | Upload image plausibility / abuse gate: `mock` (accept all) or `gemini` (real AI check) — **required, no default** |
    | `GOOGLE_GENAI_USE_VERTEXAI` | `true` to authenticate Gemini via Vertex AI + ADC (recommended; no API key). Requires `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`. Leave unset to use `GEMINI_API_KEY` instead. See [Using the image plausibility gate locally](#using-the-image-plausibility--abuse-gate-locally-plausibility_modegemini) |
    | `GOOGLE_CLOUD_PROJECT` | GCP project ID for Vertex AI (when `GOOGLE_GENAI_USE_VERTEXAI=true`) |
    | `GOOGLE_CLOUD_LOCATION` | Vertex AI location — `global`, or a region like `europe-west4` for data residency (when `GOOGLE_GENAI_USE_VERTEXAI=true`) |
    | `GEMINI_API_KEY` | Gemini **Developer API** key from Google AI Studio — the alternative to Vertex. Required when `VISION_MODE=llm` or `PLAUSIBILITY_MODE=gemini` **and** `GOOGLE_GENAI_USE_VERTEXAI` is not `true` |
    | `LOG_LEVEL` | Winston log verbosity (`error` / `warn` / `info` / `debug` / …) |

    **`bread-sheet-app/.env`** — Expo frontend:

    | Variable | Description |
    |----------|-------------|
    | `EXPO_PUBLIC_SUPABASE_URL` | Same Supabase project URL as the server |
    | `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` | Same Supabase anon/public key |
    | `EXPO_PUBLIC_API_URL` | Base URL the app uses to reach the backend (e.g. your LAN IP + port when running locally) |

    **`.env`** — root (Docker Compose / LocalStack):

    | Variable | Description |
    |----------|-------------|
    | `LOCALSTACK_AUTH_TOKEN` | Auth token for the LocalStack Pro container |

5. **Development with Docker**

    The recommended way to run the complete backend stack (PostgreSQL database, Node.js server, and LocalStack for AWS emulation) is with a single Docker Compose command.

    From the project root, run:
    ```powershell
    # Build and start localstack and db
    docker compose up
   # Switch into server directory
    cd server
    # Initialize DB and run migrations
    npm run db:deploy 
    # Switch back to project root
    cd ..
    # Start the server.
    docker compose --profile app-dev up -d --build
    ```
    Your backend is now running. The server is available at `http://localhost:3000`.

6. **Run the Server/App**
    * **Server:** Inside `/server`: `npm run db:deploy` if database changed or needs initialization, afterwards `npm run dev`
    * **Client:** `npx expo start` (inside `/bread-sheet-app`)

### Using Google Cloud Vision locally (`VISION_MODE=live`)

By default `VISION_MODE=mock` is set in `server/.env`, which returns a fixed sample response for any label image — no GCP credentials needed. To test against the real Vision API:

1. **Install the Google Cloud SDK** — [cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)

2. **Create local Application Default Credentials (ADC)**
    ```powershell
    gcloud auth application-default login
    ```
    A browser window opens; authenticate with your Google account. Credentials are written to `%APPDATA%\gcloud\application_default_credentials.json` (on Windows) and picked up automatically by the server — no `GOOGLE_APPLICATION_CREDENTIALS` env var needed locally.

3. **Enable the Vision API on your GCP project**
    ```powershell
    gcloud services enable vision.googleapis.com --project=YOUR_PROJECT_ID
    ```

4. **Grant your account the Vision User role**
    ```powershell
    gcloud projects add-iam-policy-binding YOUR_PROJECT_ID `
      --member="user:your-email@example.com" `
      --role="roles/cloudvision.user"
    ```

5. **Switch the mode in `server/.env`**
    ```env
    VISION_MODE=live
    ```

> **Production note:** In production the server pod uses Workload Identity Federation (WIF). `GOOGLE_APPLICATION_CREDENTIALS` is set to a WIF credential config file mounted via a Kubernetes ConfigMap — no service account JSON key is stored anywhere.

### Using the image plausibility / abuse gate locally (`PLAUSIBILITY_MODE=gemini`)

The Add Product flow runs an AI check on every uploaded image (TICKET-P5-005): it rejects non-product / unusable photos with actionable feedback, reads front-of-pack name/brand suggestions, and flags abusive content. With `PLAUSIBILITY_MODE=mock` (the default in `.env.example`) every image is accepted without inspection — no credentials needed. To run the real check, set `PLAUSIBILITY_MODE=gemini` and pick **one** of two auth methods (both are read by the shared `getGeminiClient()` factory — the app code is identical either way):

#### Option A — Vertex AI via ADC (recommended, no API key)

This reuses Application Default Credentials, so if you already set up `VISION_MODE=live` above, the **same `gcloud auth application-default login` covers Gemini too** — you only need to enable the Vertex API and grant the Vertex role on the same project:

1. **Enable the Vertex AI API**
    ```powershell
    gcloud services enable aiplatform.googleapis.com --project=YOUR_PROJECT_ID
    ```

2. **Grant your account the Vertex AI User role** (skip if you are project Owner/Editor)
    ```powershell
    gcloud projects add-iam-policy-binding YOUR_PROJECT_ID `
      --member="user:your-email@example.com" `
      --role="roles/aiplatform.user"
    ```

3. **Ensure ADC exists and points at this project for quota/billing** (Vertex requires billing enabled)
    ```powershell
    gcloud auth application-default login                 # if not already done for Vision
    gcloud auth application-default set-quota-project YOUR_PROJECT_ID
    ```

4. **Set the env vars in `server/.env`** (leave `GEMINI_API_KEY` unset)
    ```env
    PLAUSIBILITY_MODE=gemini
    GOOGLE_GENAI_USE_VERTEXAI=true
    GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID
    GOOGLE_CLOUD_LOCATION=global
    ```

#### Option B — Gemini Developer API key (simplest, but a long-lived secret)

Create a key at [Google AI Studio](https://aistudio.google.com/apikey) (has a free tier; no GCP project/billing required), then in `server/.env`:
```env
PLAUSIBILITY_MODE=gemini
GEMINI_API_KEY=your-key            # leave GOOGLE_GENAI_USE_VERTEXAI unset
```

#### Running under Docker with Vertex/ADC — shell caveat

Host `npm run dev` (inside `/server`) discovers ADC automatically and needs nothing extra. The `app-dev` **container** instead bind-mounts the host ADC file from `%APPDATA%\gcloud\application_default_credentials.json`, via this line in `docker-compose.yml`:

```yaml
- ${APPDATA}/gcloud/application_default_credentials.json:/root/.config/gcloud/application_default_credentials.json:ro
```

`${APPDATA}` is a **Windows** variable, so Compose only resolves it when you run `docker compose` from **PowerShell or CMD** — not from a WSL2/Linux shell (where `APPDATA` is undefined and the mount silently fails). So either:
- run the containerised stack from PowerShell, or
- just run the server on the host with `npm run dev` (recommended; sidesteps the mount entirely).

Verify the mount worked after `docker compose --profile app-dev up`:
```powershell
docker compose exec server cat /root/.config/gcloud/application_default_credentials.json
```
Non-empty JSON means ADC is available inside the container.

> **Production note:** In production, Vertex AI is the only path — `GOOGLE_GENAI_USE_VERTEXAI=true` with ADC resolving through the same Workload Identity Federation credentials used by `live` Vision (the service account needs `roles/aiplatform.user`). No `GEMINI_API_KEY` is stored. See `docs/server-production.md`.

---

### Infrastructure (Terraform)

To deploy the infrastructure locally to LocalStack:

1. Navigate to the terraform directory: `cd terraform`
2. Initialize Terraform: `terraform init`
3. Apply the configuration: `terraform apply --auto-approve`

This will create the S3 bucket and Lambda function inside the LocalStack container.
