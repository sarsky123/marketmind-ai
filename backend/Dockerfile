FROM python:3.11-slim AS base

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

FROM base AS dev
COPY . /app
RUN chmod +x /app/start.sh
EXPOSE 8000
CMD ["./start.sh"]

FROM base AS prod
COPY . /app
EXPOSE 8000
CMD ["gunicorn", "-k", "uvicorn.workers.UvicornWorker", "-w", "2", "-t", "120", "-b", "0.0.0.0:8000", "main:app"]

