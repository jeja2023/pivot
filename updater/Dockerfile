FROM swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:22-alpine

WORKDIR /updater

RUN apk add --no-cache git docker-cli docker-cli-compose

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./

EXPOSE 3300

CMD ["node", "server.js"]
