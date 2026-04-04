FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY . /app

EXPOSE 8000

# start.sh will run alembic upgrade then uvicorn (created during backend step)
RUN chmod +x /app/start.sh

CMD ["./start.sh"]

