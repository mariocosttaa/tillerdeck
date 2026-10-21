# Demo Makefile: one target per playbook per environment.
# Targets with `## description` show up as actions in Tillerdeck.
ARGS ?=

define run
@ansible-playbook $(2) -i inventories/$(1).ini -e @releases/$(1).yml $(ARGS)
endef

##@ Machine

provision-staging: ## prepare the staging machine · 01-prepare-machine
	$(call run,staging,playbooks/01-prepare-machine.yml)

provision-production: ## prepare the production machine · 01-prepare-machine
	$(call run,production,playbooks/01-prepare-machine.yml)

##@ App

deploy-api-staging: ## the API · playbooks/app/10-api.yml
	$(call run,staging,playbooks/app/10-api.yml)

deploy-api-production: ## the API · playbooks/app/10-api.yml
	$(call run,production,playbooks/app/10-api.yml)

deploy-web-staging: ## the web app · playbooks/app/20-web.yml
	$(call run,staging,playbooks/app/20-web.yml)

deploy-web-production: ## the web app · playbooks/app/20-web.yml
	$(call run,production,playbooks/app/20-web.yml)
