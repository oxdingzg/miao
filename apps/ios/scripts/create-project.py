#!/usr/bin/env python3
"""Generate the checked-in Xcode project without third-party build generators."""
from hashlib import sha256
from pathlib import Path

root = Path(__file__).resolve().parent.parent
entries = []
def ident(name):
    return sha256(name.encode()).hexdigest()[:24].upper()
def add(name, body):
    entries.append(f'\t\t{ident(name)} = {{ {body} }};')
def refs(names):
    return '(' + ', '.join(ident(name) for name in names) + ',)'
files = sorted(path.name for path in (root / 'Miao').glob('*.swift'))
for name in files:
    add('file:' + name, f'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = "{name}"; sourceTree = "<group>";')
    add('build:' + name, f'isa = PBXBuildFile; fileRef = {ident("file:" + name)};')
add('app', 'isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = Miao.app; sourceTree = BUILT_PRODUCTS_DIR;')
add('source-group', f'isa = PBXGroup; children = {refs(["file:" + name for name in files])}; path = Miao; sourceTree = "<group>";')
add('products', f'isa = PBXGroup; children = {refs(["app", "ui-product"])}; name = Products; sourceTree = "<group>";')
add('ui-file', 'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = PairingUITests.swift; sourceTree = "<group>";')
add('ui-build', f'isa = PBXBuildFile; fileRef = {ident("ui-file")};')
add('ui-group', f'isa = PBXGroup; children = {refs(["ui-file"])}; path = MiaoUITests; sourceTree = "<group>";')
add('ui-product', 'isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = MiaoUITests.xctest; sourceTree = BUILT_PRODUCTS_DIR;')
add('ui-sources', f'isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = {refs(["ui-build"])}; runOnlyForDeploymentPostprocessing = 0;')
add('ui-proxy', f'isa = PBXContainerItemProxy; containerPortal = {ident("project")}; proxyType = 1; remoteGlobalIDString = {ident("target")}; remoteInfo = Miao;')
add('ui-dependency', f'isa = PBXTargetDependency; target = {ident("target")}; targetProxy = {ident("ui-proxy")};')
add('main-group', f'isa = PBXGroup; children = {refs(["source-group", "ui-group", "products"])}; sourceTree = "<group>";')
add('package', 'isa = XCLocalSwiftPackageReference; relativePath = MiaoCore;')
add('product', f'isa = XCSwiftPackageProductDependency; package = {ident("package")}; productName = MiaoCore;')
add('framework-build', f'isa = PBXBuildFile; productRef = {ident("product")};')
add('sources', f'isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = {refs(["build:" + name for name in files])}; runOnlyForDeploymentPostprocessing = 0;')
add('frameworks', f'isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = {refs(["framework-build"])}; runOnlyForDeploymentPostprocessing = 0;')
add('resources', 'isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;')
for config in ['Debug', 'Release']:
    common = 'CLANG_ENABLE_MODULES = YES; IPHONEOS_DEPLOYMENT_TARGET = 17.0; SDKROOT = iphoneos;'
    if config == 'Debug':
        common += ' ONLY_ACTIVE_ARCH = YES; DEBUG_INFORMATION_FORMAT = dwarf; GCC_OPTIMIZATION_LEVEL = 0; SWIFT_OPTIMIZATION_LEVEL = "-Onone"; SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;'
    else:
        common += ' DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym"; SWIFT_OPTIMIZATION_LEVEL = "-O";'
    add('project:' + config, f'isa = XCBuildConfiguration; buildSettings = {{ {common} }}; name = {config};')
    target = '''CODE_SIGN_STYLE = Automatic; CURRENT_PROJECT_VERSION = 1; GENERATE_INFOPLIST_FILE = NO;
        INFOPLIST_FILE = Miao/Info.plist; MARKETING_VERSION = "$(MIAO_VERSION)";
        PRODUCT_BUNDLE_IDENTIFIER = dev.miao.remote; PRODUCT_NAME = Miao;
        SUPPORTED_PLATFORMS = "iphoneos iphonesimulator"; SWIFT_VERSION = 5.0;
        SWIFT_STRICT_CONCURRENCY = complete; TARGETED_DEVICE_FAMILY = "1,2";
        LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks";'''
    add('target:' + config, f'isa = XCBuildConfiguration; buildSettings = {{ {target} }}; name = {config};')
    ui = 'CODE_SIGN_STYLE = Automatic; GENERATE_INFOPLIST_FILE = YES; PRODUCT_BUNDLE_IDENTIFIER = dev.miao.remote.uitests; PRODUCT_NAME = MiaoUITests; SWIFT_VERSION = 5.0; TARGETED_DEVICE_FAMILY = "1,2"; TEST_TARGET_NAME = Miao;'
    add('ui:' + config, f'isa = XCBuildConfiguration; buildSettings = {{ {ui} }}; name = {config};')
for kind in ['project', 'target', 'ui']:
    add(kind + '-configs', f'isa = XCConfigurationList; buildConfigurations = {refs([kind + ":Debug", kind + ":Release"])}; defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')
add('target', f'''isa = PBXNativeTarget; buildConfigurationList = {ident("target-configs")};
    buildPhases = {refs(["sources", "frameworks", "resources"])}; buildRules = (); dependencies = ();
    name = Miao; packageProductDependencies = {refs(["product"])}; productName = Miao;
    productReference = {ident("app")}; productType = "com.apple.product-type.application";''')
add('ui-target', f'''isa = PBXNativeTarget; buildConfigurationList = {ident("ui-configs")}; buildPhases = {refs(["ui-sources"])}; buildRules = (); dependencies = {refs(["ui-dependency"])}; name = MiaoUITests; productName = MiaoUITests; productReference = {ident("ui-product")}; productType = "com.apple.product-type.bundle.ui-testing";''')
add('project', f'''isa = PBXProject; attributes = {{ BuildIndependentTargetsInParallel = YES; LastUpgradeCheck = 1500; }};
    buildConfigurationList = {ident("project-configs")}; compatibilityVersion = "Xcode 14.0";
    developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en, Base, "zh-Hans");
    mainGroup = {ident("main-group")}; packageReferences = {refs(["package"])};
    productRefGroup = {ident("products")}; projectDirPath = ""; projectRoot = ""; targets = {refs(["target", "ui-target"])};''')
(root / 'Miao.xcodeproj/project.pbxproj').write_text('// !$*UTF8*$!\n{\n\tarchiveVersion = 1;\n\tclasses = {};\n\tobjectVersion = 56;\n\tobjects = {\n' + '\n'.join(entries) + '\n\t};\n\trootObject = ' + ident('project') + ';\n}\n')
(root / 'Miao.xcodeproj/xcshareddata/xcschemes/Miao.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1500" version="1.3">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ident('target')}" BuildableName="Miao.app" BlueprintName="Miao" ReferencedContainer="container:Miao.xcodeproj"/></BuildActionEntry></BuildActionEntries></BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="NO"><Testables><TestableReference skipped="NO"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ident('ui-target')}" BuildableName="MiaoUITests.xctest" BlueprintName="MiaoUITests" ReferencedContainer="container:Miao.xcodeproj"/></TestableReference></Testables><MacroExpansion><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ident('target')}" BuildableName="Miao.app" BlueprintName="Miao" ReferencedContainer="container:Miao.xcodeproj"/></MacroExpansion><EnvironmentVariables><EnvironmentVariable key="MIAO_UI_TEST_FIXTURE" value="$(MIAO_UI_TEST_FIXTURE)" isEnabled="YES"/></EnvironmentVariables></TestAction>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ident('target')}" BuildableName="Miao.app" BlueprintName="Miao" ReferencedContainer="container:Miao.xcodeproj"/></BuildableProductRunnable></LaunchAction>
  <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugServiceExtension="internal"><BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ident('target')}" BuildableName="Miao.app" BlueprintName="Miao" ReferencedContainer="container:Miao.xcodeproj"/></BuildableProductRunnable></ProfileAction>
  <AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
''')
