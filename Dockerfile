FROM node:lts-trixie-slim AS builder

WORKDIR /app
COPY . ./

ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}
RUN corepack enable
RUN yarn install --immutable
RUN yarn build

FROM node:lts-trixie-slim AS runner
WORKDIR /app
COPY --from=builder --chown=node:node /app/package.json /app/yarn.lock /app/.yarnrc.yml ./
COPY --from=builder --chown=node:node /app/.yarn/releases ./.yarn/releases
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
RUN corepack enable

ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}

# tcp_table lookups (domain/recipient) and the SMTP delivery hand-off - see src/index.ts.
EXPOSE 10040 10041 2525
# Debugging.
EXPOSE 9229

USER node

ENTRYPOINT ["node", "dist/src/index.js"]
