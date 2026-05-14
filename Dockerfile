FROM node:20-slim

WORKDIR /app

# Install build dependencies for better-sqlite3 (native C++ addon)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy app files
COPY src/ ./src/
COPY public/ ./public/

# Create data directory for SQLite (mount volume here on Railway)
RUN mkdir -p /app/data

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "src/server.js"]
