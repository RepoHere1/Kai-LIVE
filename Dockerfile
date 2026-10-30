# Kai-LIVE - Railway Deployment
FROM node:20-alpine

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy application code
COPY . .

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Create directories for state/logs with proper ownership
RUN mkdir -p /app/logs /app/data && \
    chown -R nodejs:nodejs /app

USER nodejs

# Expose port
EXPOSE 8788

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8788/api/health', (res) => {process.exit(res.statusCode === 200 ? 0 : 1)})"

# Start server
CMD ["node", "server.js"]