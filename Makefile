APP_NAME = MarkdownPreview
SCHEME   = MarkdownPreview
PROJECT  = MarkdownPreview.xcodeproj
DERIVED  = $(HOME)/Library/Developer/Xcode/DerivedData
BUILT    = $(shell find $(DERIVED) -name "$(APP_NAME).app" -path "*/Debug/*" 2>/dev/null | head -1)

.PHONY: build install open clean

build:
	xcodegen generate
	xcodebuild -project $(PROJECT) -scheme $(SCHEME) -configuration Debug build

install: build
	rm -rf /Applications/$(APP_NAME).app
	cp -R "$(BUILT)" /Applications/$(APP_NAME).app
	/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
		-f /Applications/$(APP_NAME).app
	@echo "Installed to /Applications/$(APP_NAME).app"

open: install
	open /Applications/$(APP_NAME).app

clean:
	rm -rf $(DERIVED)/$(APP_NAME)-*
