# Single image: the API serves the built web app from the same origin.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app/apps/api
ENV NODE_ENV=production PORT=4000 WEB_DIST=/app/apps/web/dist UPLOAD_DIR=/data/uploads
COPY --from=build /app/package.json /app/package-lock.json /app/.npmrc /app/
COPY --from=build /app/packages/shared /app/packages/shared
COPY --from=build /app/apps/api/package.json ./
COPY --from=build /app/apps/web/package.json /app/apps/web/package.json
RUN cd /app && npm ci --omit=dev --workspace @edumin/api --include-workspace-root=false
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/drizzle ./drizzle
COPY --from=build /app/apps/web/dist /app/apps/web/dist
VOLUME ["/data"]
EXPOSE 4000
# Apply migrations, then start.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/server.js"]
