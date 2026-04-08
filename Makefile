.PHONY: up down build start-all start-infra start-backend start-frontend start-redisinsight restart ps logs-backend logs-frontend logs-postgres logs-redis db-migrate db-upgrade

COMPOSE_DEV = docker compose -f docker-compose.yml -f docker-compose.dev.yml
COMPOSE_PROD = docker compose -f docker-compose.yml -f docker-compose.prod.yml

up:
	$(COMPOSE_DEV) up --build

build:
	$(COMPOSE_DEV) build

start-all:
	$(COMPOSE_DEV) up -d

start-infra:
	$(COMPOSE_DEV) up -d postgres redis

start-backend:
	$(COMPOSE_DEV) up -d backend --build

start-frontend:
	$(COMPOSE_DEV) up -d frontend --build

start-redisinsight:
	$(COMPOSE_DEV) up -d redisinsight

restart:
	docker start aift-postgres aift-redis aift-backend aift-frontend aift-redisinsight

ps:
	$(COMPOSE_DEV) ps

logs-backend:
	$(COMPOSE_DEV) logs -f backend

logs-frontend:
	$(COMPOSE_DEV) logs -f frontend

logs-postgres:
	$(COMPOSE_DEV) logs -f postgres

logs-redis:
	$(COMPOSE_DEV) logs -f redis

down:
	$(COMPOSE_DEV) down

db-migrate:
	$(COMPOSE_DEV) exec backend alembic revision --autogenerate -m "$(MSG)"

db-upgrade:
	$(COMPOSE_DEV) exec backend alembic upgrade head

