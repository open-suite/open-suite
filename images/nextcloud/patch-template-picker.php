<?php

declare(strict_types=1);

// Apply the pinned NC34 lazy TemplatePicker readiness fix fail-closed.
const FILES_INIT_SHA256 = 'b70e746da0f331f19e8deaf494f806baea2decd4de9964d1f2c99dbeb136fc18';
const FILES_INIT_MAP_SHA256 = '208945a2b732e8e863915e98544bac78ea6958898d149c3f23ab756897362ea8';
const TEMPLATE_PICKER_CHUNK_SHA256 = '0400acc742f52d27ad940a2fdc3cb216b1181e35d05882e7797ad24e991d9710';
const TEMPLATE_PICKER_CHUNK_MAP_SHA256 = 'fdce7694964d98df40e135d37a26d92d3d7a2e167da6697c0f4b88e3e1fe7ecc';
const TEMPLATE_PICKER_MAP_FILE = '7497-7497.js?v=4c13f30ae7ab10413c2e';
const TEMPLATE_PICKER_RUNTIME_URL = '7497-7497.js?v=94a5bd32402d33b444dc';
const VIEW_CONTROLLER_SHA256 = '809cb4156b66c9460ca20137ca3b8768ea241c2968e2accd5f72a4417eb82c79';
const PATCHED_BUNDLE_SHA256 = 'd391378ea51e3495a9a1f480597758dc9504f1dfd33fd5229324a5a9b2729dff';

const OLD_IMPORT = "import Vue, { defineAsyncComponent } from 'vue';";
const NEW_IMPORT = "import Vue from 'vue';";
const OLD_SOURCE_LOADER = <<<'SOURCE'
// async to reduce bundle size
const TemplatePickerVue = defineAsyncComponent(() => import('../views/TemplatePicker.vue'));
SOURCE;
const NEW_SOURCE_LOADER = <<<'SOURCE'
// Cache the first lazy import so every caller shares its resolution or rejection.
let TemplatePickerVue = null;
SOURCE;

const VULNERABLE_SOURCE = <<<'SOURCE'
let TemplatePicker = null;
/**
 *
 * @param context
 */
async function getTemplatePicker(context) {
    if (TemplatePicker === null) {
        // Create document root
        const mountingPoint = document.createElement('div');
        mountingPoint.id = 'template-picker';
        document.body.appendChild(mountingPoint);
        // Init vue app
        TemplatePicker = new Vue({
            render: (h) => h(TemplatePickerVue, {
                ref: 'picker',
                props: {
                    parent: context,
                },
            }),
            methods: { open(...args) { this.$refs.picker.open(...args); } },
            el: mountingPoint,
        });
    }
    return TemplatePicker;
}
SOURCE;

const PATCHED_SOURCE = <<<'SOURCE'
let TemplatePicker = null;
/**
 *
 * @param context
 */
async function getTemplatePicker(context) {
    TemplatePickerVue ??= import('../views/TemplatePicker.vue');
    const { default: TemplatePickerComponent } = await TemplatePickerVue;
    if (TemplatePicker === null) {
        // Create document root
        const mountingPoint = document.createElement('div');
        mountingPoint.id = 'template-picker';
        document.body.append(mountingPoint);
        // Init vue app
        TemplatePicker = new Vue({
            render: (h) => h(TemplatePickerComponent, {
                ref: 'picker',
                props: {
                    parent: context,
                },
            }),
            methods: { open(...args) { this.$refs.picker.open(...args); } },
            el: mountingPoint,
        });
    }
    return TemplatePicker;
}
SOURCE;

const OLD_BUNDLE = 'tn=(0,x.$V)(()=>Promise.all([t.e(4208),t.e(7497)]).then(t.bind(t,27497)));let nn=null;';
const NEW_BUNDLE = 'tn=null,opensuiteTemplatePickerLoader=()=>Promise.all([t.e(4208),t.e(7497)]).then(t.bind(t,27497));let nn=null;';
const OLD_FACTORY = 'const n=async function(e){if(null===nn){const s=document.createElement("div");s.id="template-picker",document.body.appendChild(s),nn=new x.Ay({render:s=>s(tn,{ref:"picker",props:{parent:e}}),methods:{open(...e){this.$refs.picker.open(...e)}},el:s})}return nn}(s)';
const NEW_FACTORY = 'const n=async function(e){tn||=Promise.all([t.e(4208),t.e(7497)]).then(t.bind(t,27497));const{default:i}=await tn;if(!nn){const s=document.createElement("div");s.id="template-picker",document.body.append(s),nn=new x.Ay({render:s=>s(i,{ref:"picker",props:{parent:e}}),methods:{open(...e){this.$refs.picker.open(...e)}},el:s})}return nn}(s)';
const OLD_CONTROLLER = "\t\tUtil::addInitScript('files', 'init');";
const NEW_CONTROLLER = "\t\tUtil::addInitScript('files', 'init-opensuite-tp2');";

function requireCount(string $content, string $fragment, int $expected, string $label): void {
	$actual = substr_count($content, $fragment);
	if ($actual !== $expected) {
		throw new RuntimeException("{$label}: expected {$expected} occurrence(s), found {$actual}");
	}
}

function readFileStrict(string $path): string {
	$content = file_get_contents($path);
	if ($content === false) {
		throw new RuntimeException("could not read {$path}");
	}
	return $content;
}

function transformBundle(string $bundle): string {
	[$runtimeBasename, $runtimeVersion] = explode('?v=', TEMPLATE_PICKER_RUNTIME_URL, 2);
	if ($runtimeBasename !== explode('?', TEMPLATE_PICKER_MAP_FILE, 2)[0]) {
		throw new RuntimeException('NC34 TemplatePicker runtime and source-map basenames differ');
	}
	requireCount($bundle, OLD_BUNDLE, 1, 'NC34 TemplatePicker loader preimage');
	requireCount($bundle, OLD_FACTORY, 1, 'NC34 vulnerable TemplatePicker factory');
	requireCount($bundle, 'a.u=e=>e+"-"+e+".js?v="+', 1, 'NC34 physical chunk URL builder');
	requireCount($bundle, "7497:\"{$runtimeVersion}\"", 1, 'NC34 TemplatePicker physical chunk URL version');
	requireCount($bundle, NEW_BUNDLE, 0, 'patched TemplatePicker loader before transform');
	requireCount($bundle, NEW_FACTORY, 0, 'patched TemplatePicker factory before transform');
	$candidate = str_replace([OLD_BUNDLE, OLD_FACTORY], [NEW_BUNDLE, NEW_FACTORY], $bundle);
	requireCount($candidate, OLD_FACTORY, 0, 'vulnerable TemplatePicker factory after transform');
	requireCount($candidate, NEW_BUNDLE, 1, 'patched TemplatePicker loader');
	requireCount($candidate, NEW_FACTORY, 1, 'patched TemplatePicker factory');
	$candidate = str_replace(
		'tn||=Promise.all([t.e(4208),t.e(7497)]).then(t.bind(t,27497));const{default:i}=await tn',
		'tn||=opensuiteTemplatePickerLoader();const{default:i}=await tn',
		$candidate,
	);
	requireCount($candidate, 'tn||=opensuiteTemplatePickerLoader();const{default:i}=await tn;if(!nn)', 1, 'cached lazy import readiness before wrapper construction');
	requireCount($candidate, 'this.$refs.picker.open', 1, 'TemplatePicker open forwarding');
	$directives = 0;
	$candidate = preg_replace('/\n\/\/# sourceMappingURL=files-init\.js\.map(\?v=[0-9a-f]+)\s*$/', "\n//# sourceMappingURL=files-init-opensuite-tp2.js.map$1\n", $candidate, 1, $directives);
	if ($candidate === null || $directives !== 1) {
		throw new RuntimeException('expected to replace exactly one upstream source-map directive');
	}
	return $candidate;
}

if ($argc !== 2) {
	fwrite(STDERR, "usage: {$argv[0]} NEXTCLOUD_ROOT\n");
	exit(2);
}

$root = rtrim($argv[1], '/');
$dist = "{$root}/dist";
$bundlePath = "{$dist}/files-init.js";
$mapPath = "{$dist}/files-init.js.map";
$pickerMaps = [];
foreach (glob("{$dist}/*.js.map") ?: [] as $candidateMapPath) {
	$candidateMapContent = readFileStrict($candidateMapPath);
	if (!str_contains($candidateMapContent, 'apps/files/src/views/TemplatePicker.vue')) {
		continue;
	}
	$candidateMap = json_decode($candidateMapContent, true, 512, JSON_THROW_ON_ERROR);
	foreach ($candidateMap['sources'] ?? [] as $source) {
		if (str_ends_with($source, 'apps/files/src/views/TemplatePicker.vue')) {
			$pickerMaps[] = [$candidateMapPath, $candidateMap];
			break;
		}
	}
}
if (count($pickerMaps) !== 1) {
	throw new RuntimeException('expected exactly one physical NC34 TemplatePicker source map');
}
[$chunkMapPath, $chunkMap] = $pickerMaps[0];
if (($chunkMap['file'] ?? null) !== TEMPLATE_PICKER_MAP_FILE) {
	throw new RuntimeException('pinned NC34 TemplatePicker source-map file mismatch');
}
$chunkBasename = explode('?', TEMPLATE_PICKER_MAP_FILE, 2)[0];
if (basename($chunkMapPath) !== "{$chunkBasename}.map") {
	throw new RuntimeException('NC34 TemplatePicker source map does not match its physical JS basename');
}
$chunkPath = "{$dist}/{$chunkBasename}";
$controllerPath = "{$root}/apps/files/lib/Controller/ViewController.php";
$expected = [
	$bundlePath => FILES_INIT_SHA256,
	$mapPath => FILES_INIT_MAP_SHA256,
	$chunkPath => TEMPLATE_PICKER_CHUNK_SHA256,
	$chunkMapPath => TEMPLATE_PICKER_CHUNK_MAP_SHA256,
	$controllerPath => VIEW_CONTROLLER_SHA256,
];
foreach ($expected as $path => $digest) {
	if (!is_file($path) || hash_file('sha256', $path) !== $digest) {
		throw new RuntimeException("pinned NC34 preimage hash mismatch: {$path}");
	}
}

$sourceMap = json_decode(readFileStrict($mapPath), true, 512, JSON_THROW_ON_ERROR);
$matches = [];
foreach ($sourceMap['sources'] as $index => $source) {
	if (str_ends_with($source, 'apps/files/src/newMenu/newFromTemplate.ts')) {
		$matches[] = $index;
	}
}
if (count($matches) !== 1) {
	throw new RuntimeException('expected exactly one authoritative newFromTemplate.ts source');
}
$sourceIndex = $matches[0];
$authoritativeSource = $sourceMap['sourcesContent'][$sourceIndex];
requireCount($authoritativeSource, OLD_IMPORT, 1, 'authoritative defineAsyncComponent import');
requireCount($authoritativeSource, OLD_SOURCE_LOADER, 1, 'authoritative lazy wrapper loader');
requireCount($authoritativeSource, VULNERABLE_SOURCE, 1, 'authoritative vulnerable NC34 source');
$sourceMap['sourcesContent'][$sourceIndex] = str_replace(
	[OLD_IMPORT, OLD_SOURCE_LOADER, VULNERABLE_SOURCE],
	[NEW_IMPORT, NEW_SOURCE_LOADER, PATCHED_SOURCE],
	$authoritativeSource,
);
requireCount($sourceMap['sourcesContent'][$sourceIndex], 'defineAsyncComponent', 0, 'patched authoritative source async wrapper');
requireCount($sourceMap['sourcesContent'][$sourceIndex], 'await TemplatePickerVue', 1, 'patched authoritative source import await');
$sourceMap['file'] = 'files-init-opensuite-tp2.js';
// Do not retain misleading generated positions after transforming the pinned
// minified bundle. The corrected authoritative source remains available.
$sourceMap['mappings'] = '';

$patchedPath = "{$dist}/files-init-opensuite-tp2.js";
$patchedMapPath = "{$dist}/files-init-opensuite-tp2.js.map";
$temporaryPath = "{$patchedPath}.tmp";
if (file_put_contents($temporaryPath, transformBundle(readFileStrict($bundlePath))) === false
		|| !rename($temporaryPath, $patchedPath)) {
	throw new RuntimeException('could not atomically publish patched TemplatePicker bundle');
}
if (($patchedBundleHash = hash_file('sha256', $patchedPath)) !== PATCHED_BUNDLE_SHA256) {
	throw new RuntimeException("patched TemplatePicker bundle hash mismatch: {$patchedBundleHash}");
}
$encodedMap = json_encode($sourceMap, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
if (file_put_contents($patchedMapPath, $encodedMap) === false) {
	throw new RuntimeException('could not publish patched TemplatePicker source map');
}

$controller = readFileStrict($controllerPath);
requireCount($controller, OLD_CONTROLLER, 1, 'NC34 Files init registration');
requireCount($controller, NEW_CONTROLLER, 0, 'patched Files init registration before transform');
$patchedController = str_replace(OLD_CONTROLLER, NEW_CONTROLLER, $controller);
if (file_put_contents($controllerPath, $patchedController) === false) {
	throw new RuntimeException('could not publish patched Files controller');
}
requireCount(readFileStrict($controllerPath), OLD_CONTROLLER, 0, 'old Files init registration after transform');
requireCount(readFileStrict($controllerPath), NEW_CONTROLLER, 1, 'patched Files init registration');
requireCount(readFileStrict($patchedPath), NEW_FACTORY, 1, 'persisted TemplatePicker candidate');
printf("patched NC34 TemplatePicker bundle sha256=%s\n", hash_file('sha256', $patchedPath));
