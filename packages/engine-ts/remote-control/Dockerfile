FROM oven/bun:1.3.14-slim
WORKDIR /app
COPY --chown=bun:bun dist/hub.mjs ./hub.mjs
COPY --chown=bun:bun dist/web/ ./web/
USER bun
ENV MIAO_HUB_HOST=0.0.0.0 MIAO_HUB_PORT=4600 MIAO_HUB_CONFIG=/config/hub.json
EXPOSE 4600
CMD ["bun", "hub.mjs"]
