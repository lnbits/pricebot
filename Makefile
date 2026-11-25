.PHONY: check build

check: build
	cd dev && npm run check

build:
	cd dev && npm run build
