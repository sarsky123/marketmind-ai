.PHONY: up down db-migrate db-upgrade

up:
	docker-compose up --build

down:
	docker-compose down

db-migrate:
	docker-compose exec backend alembic revision --autogenerate -m "$(MSG)"

db-upgrade:
	docker-compose exec backend alembic upgrade head

