FROM node:24-alpine

WORKDIR /usr/src/app

# Install OpenSSL (required for Prisma on Alpine)
RUN apk add --no-cache openssl

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code, generate the Prisma client, and build.
# prisma.config.ts resolves env("DATABASE_URL") at load time, but `generate` never
# connects to the DB, so a placeholder satisfies the config. The real URL is supplied
# at runtime (compose env), where db:deploy regenerates against the live database.
COPY . .
RUN DATABASE_URL="postgresql://placeholder" npx prisma generate
RUN npm run build

EXPOSE 3000

# This command is the fallback if not specified in docker-compose
# The actual startup command will be in docker-compose.yml to run migrations
CMD ["node", "dist/server.js"]


# FROM node:24-alpine

# WORKDIR /usr/src/app

# # Install OpenSSL (required for Prisma on Alpine)
# RUN apk add --no-cache openssl

# COPY package*.json ./

# RUN npm install

# COPY . .

# RUN npm run prisma:generate
# RUN npm ci

# EXPOSE 3000

# CMD ["/bin/sh", "-c", "node", " dist/server.js"]
