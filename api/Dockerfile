FROM python:3.11-alpine
RUN pip install --no-cache-dir pypinyin==0.55.0 "qrcode>=7.4,<9"
WORKDIR /app
# build context = repo root (see compose.snippet.yml)
COPY api/moontv-api.py /app/moontv-api.py
# TV app + browser simulator served at /tv/ and /sim (optional: drop these two lines for API-only)
COPY app /app/tv
COPY sim /app/sim
ENV MOONTV_UPSTREAM=http://moontv-core:3000 \
    MOONTV_CACHE=/cache \
    MOONTV_PORT=8788 \
    MOONTV_APP_DIR=/app/tv \
    MOONTV_SIM=/app/sim/index.html \
    PYTHONUNBUFFERED=1
VOLUME ["/cache"]
EXPOSE 8788
HEALTHCHECK --interval=60s --timeout=5s --retries=3 CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8788/health',timeout=4).status==200 else 1)"
CMD ["python3", "/app/moontv-api.py"]
