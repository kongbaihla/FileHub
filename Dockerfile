# FileHub — container image.
#
# This app is not serverless-shaped: it keeps SQLite on disk and writes every
# uploaded file beside it. Both live under FILEHUB_DATA (default /app/data), so
# that one directory is what a host has to make durable — see docker-compose.yml
# and DEPLOY.md.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    FILEHUB_DATA=/app/data

WORKDIR /app

# Dependencies first: this layer is cached and only rebuilt when the list
# changes, so ordinary code edits do not reinstall anything.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Seed the data directory from the checkout, so a fresh volume comes up with the
# site as it looks now instead of an empty one. The app reads FILEHUB_DATA
# (default /app/data) while the repository keeps its state at the project root,
# so without this the image would carry filehub.db somewhere the app never
# looks and a first `docker compose up` would show an empty site.
RUN mkdir -p /app/data && \
    if [ -f /app/filehub.db ]; then cp /app/filehub.db /app/data/filehub.db; fi && \
    if [ -d /app/uploads ]; then mkdir -p /app/data/uploads && cp -r /app/uploads/. /app/data/uploads/; fi

# A non-root user that owns the writable path. Without this the container runs
# as root and the host ends up with root-owned files on the volume.
RUN useradd --create-home --uid 10001 filehub \
 && chown -R filehub:filehub /app
USER filehub

EXPOSE 8000
# PORT comes from the environment when the host sets one; 8000 otherwise.
CMD ["python", "server/main.py"]
