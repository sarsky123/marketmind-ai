.PHONY: up down build start-all start-infra start-backend start-frontend start-redisinsight restart ps logs-backend logs-frontend logs-postgres logs-redis db-migrate db-upgrade

up:
	docker compose up --build

build:
	docker compose build

start-all:
	docker compose up -d

start-infra:
	docker compose up -d postgres redis

start-backend:
	docker compose up -d backend --build

start-frontend:
	docker compose up -d frontend --build

start-redisinsight:
	docker compose up -d redisinsight

restart:
	docker start aift-postgres aift-redis aift-backend aift-frontend aift-redisinsight

ps:
	docker compose ps

logs-backend:
	docker compose logs -f backend

logs-frontend:
	docker compose logs -f frontend

logs-postgres:
	docker compose logs -f postgres

logs-redis:
	docker compose logs -f redis

down:
	docker compose down

db-migrate:
	docker compose exec backend alembic revision --autogenerate -m "$(MSG)"

db-upgrade:
	docker compose exec backend alembic upgrade head

