FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY sql ./sql
COPY public ./public
COPY client ./client
COPY test ./test
CMD ["node","--test","test/mysql.integration.mjs"]
