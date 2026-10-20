FROM node:20-alpine

# ffmpeg/ffprobe power HLS downloads, quality truth-check, stickers and mp4 fixes
# python3 lets the auto-installed yt-dlp standalone binary run
RUN apk add --no-cache ffmpeg ca-certificates python3

WORKDIR /app
COPY package.json ./
# optional deps (baileys + qrcode-terminal); engine itself needs nothing
RUN npm install --omit=dev || true

COPY bot.js cli.js ./
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
ENV TEMP_DIR=/data/temp
ENV CACHE_FILE=/data/temp/cache-store.json
ENV SESSION_DIR=/data/session
ENV DATA_DIR=/data
ENV JOB_DIR=/data/temp/jobs
VOLUME ["/data"]

CMD ["node", "bot.js"]
