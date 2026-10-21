# Demo Makefile, in the naming convention Ansible Mario recognises:
#
#     verb - product - technology - environment
#     deploy-demo-nestjs-staging
#
# Targets with `## description` show up as actions; `##@ title` makes sections.
ARGS ?=
# What a restore brings back: all, db or storage.
SCOPE ?= all
SNAPSHOT ?= latest

define run
@ansible-playbook $(2) -i inventories/$(1).ini -e @releases/$(1).yml $(3) $(ARGS)
endef

##@ demo · the example app

deploy-demo-nestjs-staging: ## demo-api · playbooks/demo/20-nestjs.yml
	$(call run,staging,playbooks/demo/20-nestjs.yml)
deploy-demo-nestjs-production: ## demo-api · playbooks/demo/20-nestjs.yml
	$(call run,production,playbooks/demo/20-nestjs.yml)
run-migrations-demo-nestjs-staging: ## demo-api, migrations only
	$(call run,staging,playbooks/demo/20-nestjs.yml,--tags migrations)
run-migrations-demo-nestjs-production: ## demo-api, migrations only
	$(call run,production,playbooks/demo/20-nestjs.yml,--tags migrations)
deploy-demo-nextjs-staging: ## demo-web · playbooks/demo/21-nextjs.yml
	$(call run,staging,playbooks/demo/21-nextjs.yml)
deploy-demo-nextjs-production: ## demo-web · playbooks/demo/21-nextjs.yml
	$(call run,production,playbooks/demo/21-nextjs.yml)
maintenance-on-demo-nextjs-staging: ## close demo-web to users
	$(call run,staging,playbooks/40-maintenance.yml)
maintenance-on-demo-nextjs-production: ## close demo-web to users
	$(call run,production,playbooks/40-maintenance.yml)
maintenance-off-demo-nextjs-staging: ## reopen demo-web
	$(call run,staging,playbooks/40-maintenance.yml)
maintenance-off-demo-nextjs-production: ## reopen demo-web
	$(call run,production,playbooks/40-maintenance.yml)
deploy-demo-nginx-staging: ## nginx in front of the API · 22-nginx
	$(call run,staging,playbooks/demo/22-nginx.yml)
deploy-demo-nginx-production: ## nginx in front of the API · 22-nginx
	$(call run,production,playbooks/demo/22-nginx.yml)
deploy-demo-postgres-staging: ## the database · 10-postgres
	$(call run,staging,playbooks/demo/10-postgres.yml)
deploy-demo-postgres-production: ## the database · 10-postgres
	$(call run,production,playbooks/demo/10-postgres.yml)
deploy-demo-redis-staging: ## the job queue · 11-redis
	$(call run,staging,playbooks/demo/11-redis.yml)
deploy-demo-redis-production: ## the job queue · 11-redis
	$(call run,production,playbooks/demo/11-redis.yml)

##@ Backups

deploy-backup-staging: ## the backup service · 30-backup
	$(call run,staging,playbooks/30-backup.yml)
deploy-backup-production: ## the backup service · 30-backup
	$(call run,production,playbooks/30-backup.yml)
restore-staging: ## rehearse a restore on staging · SNAPSHOT=latest SCOPE=all|db|storage
	$(call run,staging,playbooks/31-restore.yml,-e snapshot=$(SNAPSHOT) -e scope=$(SCOPE))
restore-production: ## restore production from a snapshot · SNAPSHOT=latest SCOPE=all|db|storage
	$(call run,production,playbooks/31-restore.yml,-e snapshot=$(SNAPSHOT) -e scope=$(SCOPE))

##@ Provisioning

provision-system-staging: ## system, swap and Docker · 01-prepare-machine
	$(call run,staging,playbooks/01-prepare-machine.yml)
provision-system-production: ## system, swap and Docker · 01-prepare-machine
	$(call run,production,playbooks/01-prepare-machine.yml)

##@ Verify · nothing here writes to the machine

ping-staging: ## does the machine answer?
	@ansible all -i inventories/staging.ini -m ping
ping-production: ## does the machine answer?
	@ansible all -i inventories/production.ini -m ping
