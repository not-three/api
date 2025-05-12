FROM node:24-alpine as build-stage
WORKDIR /app
RUN npm install -g pnpm
COPY package.json .
COPY pnpm-lock.yaml .
RUN pnpm install
COPY . .
RUN pnpm build
RUN pnpm prune --prod

FROM node:24-alpine
RUN apk add --no-cache curl
WORKDIR /app

COPY --from=build-stage /app/dist .
COPY --from=build-stage /app/LICENSE LICENSE
COPY --from=build-stage /app/docs ./docs
COPY --from=build-stage /app/node_modules ./node_modules

EXPOSE 4000
ENV NODE_ENV=production
LABEL org.opencontainers.image.source=https://github.com/not-three/api
LABEL org.opencontainers.image.title="not-th.re/api"
LABEL org.opencontainers.image.description="!3 is a simple, secure and open source paste sharing platform."
LABEL org.opencontainers.image.authors="Joschua Becker EDV <support@scolasti.co>"
STOPSIGNAL SIGINT

CMD ["node", "src/main.js"]
