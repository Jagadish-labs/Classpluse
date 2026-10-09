FROM node:20-alpine

WORKDIR /app

# Native build tools needed for better-sqlite3 compilation on Alpine
RUN apk add --no-cache python3 make g++

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
