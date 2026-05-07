EXT_NAME := local.unpacked.christopher-le.personal-knowledge-base
EXT      := $(HOME)/Library/Application Support/Claude/Claude Extensions/$(EXT_NAME)

.PHONY: all build build-dashboard build-server sync watch clean

all: build

## Build server + dashboard and sync both to the installed extension
build: build-server build-dashboard

## Compile the MCP server (TypeScript → server/dist/) and sync to extension
## Note: changes take effect after restarting the extension in Claude Desktop
build-server:
	cd server && npm run build
	rsync -a --delete server/dist/ "$(EXT)/server/dist/"

## Build the Next.js static export and sync to the installed extension
## Note: no restart needed — server reads static files from disk on each request
build-dashboard:
	cd dashboard && npm run build
	rsync -a --delete dashboard/out/ "$(EXT)/dashboard/out/"

## Sync build artifacts to the extension without rebuilding
sync:
	rsync -a --delete server/dist/ "$(EXT)/server/dist/"
	rsync -a --delete dashboard/out/ "$(EXT)/dashboard/out/"

## Watch server/src and dashboard source; rebuild and sync on every save
## Two fswatch processes run in parallel; Ctrl-C kills both
## Requires fswatch: brew install fswatch
watch:
	@command -v fswatch >/dev/null 2>&1 || \
		{ echo "error: fswatch not found — install with: brew install fswatch"; exit 1; }
	@echo "Watching server/src, dashboard/app, dashboard/components, dashboard/lib …"
	@trap 'kill 0' INT TERM; \
		fswatch -o server/src | \
			while read; do $(MAKE) --no-print-directory build-server; done & \
		fswatch -o dashboard/app dashboard/components dashboard/lib | \
			while read; do $(MAKE) --no-print-directory build-dashboard; done; \
		wait

## Remove build artifacts
clean:
	cd dashboard && npm run clean
	cd server && npm run clean
