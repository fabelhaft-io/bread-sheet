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

This project consists of two parts with different recommended terminal environments on Windows:

| Part | Recommendations                                                                       |
|------|---------------------------------------------------------------------------------------|
| `server/` — Node.js API + Docker | **WSL2**                                                                              |
| `bread-sheet-app/` — Expo / React Native | **WSL2** (building docker container of backend) <br/><br/>**Native Windows** (PowerShell / CMD) |

### Why native Windows for the Expo app?

Expo needs to detect your local network interface to serve the dev bundle to physical devices or emulators. Running from WSL2 can cause network discovery issues (wrong IP, unreachable Metro server). Use a native Windows terminal here.

### Why WSL2 for the server and building the Docker containers?

Docker on Windows works best when build commands are run from a WSL2 terminal. It avoids bind-mount performance issues and path translation problems that occur with Windows paths.

In IntelliJ / WebStorm you can open a WSL2 terminal directly:
`View → Tool Windows → Terminal`, then select your WSL distro from the terminal dropdown.


1. **Clone the repository**
2. **Install React App Dependencies**

    ```bash
    cd bread-sheet-app
    npm install
    ```

    For the Add Product flow (TICKET-P5-002) you'll additionally need:
    ```bash
    npx expo install expo-image-picker expo-image-manipulator
    npm install @react-native-ml-kit/text-recognition
    ```
    These native dependencies are loaded via guarded `require()` in `features/products/`, so tests and the sign-up/sign-in flows work without them — but the camera capture, on-device OCR, and image processing won't run until they're installed and the native client is rebuilt (Expo Go is not sufficient; use a dev build).

3. **Install Server Dependencies**

    ```bash
    cd ../server
    npm install
    ```

4. **Environment Setup**

    This project requires a [Supabase](https://supabase.com) project for authentication. Create a free project at supabase.com, then find your **Project URL** and **anon/public key** under **Project Settings → API**. Additionally enable anonymous login for the project.

    * Create a `./server/.env` file:

        ```env
        PORT=3000
        NODE_ENV=development
        DATABASE_URL="postgresql://admin:password@localhost:5432/breadsheet"
        SUPABASE_URL=https://<your-project-ref>.supabase.co
        SUPABASE_PUBLISHABLE_DEFAULT_KEY=<your-anon-key>
        VISION_MODE=mock                              # 'mock' | 'live' — required, no default
        # GOOGLE_APPLICATION_CREDENTIALS=/path/to/wif-config.json  # required for VISION_MODE=live
        ```

    * Create a `./bread-sheet-app/.env` file:

        ```env
        EXPO_PUBLIC_SUPABASE_URL=https://<your-project-ref>.supabase.co
        EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=<your-anon-key>
        ```

5. **Development with Docker**

    The recommended way to run the complete backend stack (PostgreSQL database, Node.js server, and LocalStack for AWS emulation) is with a single Docker Compose command.

    From the project root, run:
    ```bash
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

### Infrastructure (Terraform)

To deploy the infrastructure locally to LocalStack:

1. Navigate to the terraform directory: `cd terraform`
2. Initialize Terraform: `terraform init`
3. Apply the configuration: `terraform apply --auto-approve`

This will create the S3 bucket and Lambda function inside the LocalStack container.
