FROM node:20-alpine

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Ensure data directory exists
RUN mkdir -p /app/data

EXPOSE ${PORT:-3002}

CMD ["node", "server.cjs"]
