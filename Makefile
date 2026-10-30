.DEFAULT_GOAL := help
.PHONY: help test try

PI ?= pi

help: ## List the available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

test: ## Run the test suite
	bun run test

try: ## Open a pi session with this extension loaded, for a live walkthrough
	$(PI) -ne -e ./index.ts
