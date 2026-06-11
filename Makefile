.PHONY: engines build app dmg release run verify clean

engines:
	Scripts/fetch_media_engines.sh

build: engines
	swift build -c release

app:
	Scripts/create_app_bundle.sh

dmg: app
	Scripts/create_dmg.sh

release:
	Scripts/create_app_bundle.sh
	Scripts/create_dmg.sh

run: engines
	swift run Firelink

verify:
	Scripts/verify.sh

clean:
	swift package clean
	rm -rf build dist
