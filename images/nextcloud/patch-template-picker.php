<?php

declare(strict_types=1);

// Apply the pinned NC34 lazy TemplatePicker readiness fix fail-closed.
const FILES_INIT_SHA256 = 'b70e746da0f331f19e8deaf494f806baea2decd4de9964d1f2c99dbeb136fc18';
const FILES_INIT_MAP_SHA256 = '208945a2b732e8e863915e98544bac78ea6958898d149c3f23ab756897362ea8';
const TEMPLATE_PICKER_CHUNK_SHA256 = '0400acc742f52d27ad940a2fdc3cb216b1181e35d05882e7797ad24e991d9710';
const TEMPLATE_PICKER_CHUNK_MAP_SHA256 = 'fdce7694964d98df40e135d37a26d92d3d7a2e167da6697c0f4b88e3e1fe7ecc';
const VIEW_CONTROLLER_SHA256 = '809cb4156b66c9460ca20137ca3b8768ea241c2968e2accd5f72a4417eb82c79';
const PATCHED_BUNDLE_SHA256 = 'f3140718058e3b5c75f3e1383d8c9cabadfde32eb52ae56f93117ffc0e7c2031';

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

const OLD_BUNDLE = 'tn=(0,x.$V)(()=>Promise.all([t.e(4208),t.e(7497)]).then(t.bind(t,27497)));let nn=null;';
const NEW_BUNDLE = 'tn=(0,x.$V)(()=>Promise.all([t.e(4208),t.e(7497)]).then(t.bind(t,27497)).then(e=>(e.default.mixins=[...(e.default.mixins||[]),{mounted:ir}],e)));let nn=null,ir,ar=new Promise(e=>{ir=e});';
const OLD_FACTORY = 'const n=async function(e){if(null===nn){const s=document.createElement("div");s.id="template-picker",document.body.appendChild(s),nn=new x.Ay({render:s=>s(tn,{ref:"picker",props:{parent:e}}),methods:{open(...e){this.$refs.picker.open(...e)}},el:s})}return nn}(s)';
const NEW_FACTORY = 'const n=async function(e){if(null===nn){const s=document.createElement("div");s.id="template-picker",document.body.appendChild(s),nn=new x.Ay({render:s=>s(tn,{ref:"picker",props:{parent:e}}),methods:{open(...e){this.$refs.picker.open(...e)}},el:s})}if(await ar,"function"!=typeof nn?.$refs?.picker?.open)throw new Error("Template picker mounted without an open method");return nn}(s)';
const OLD_CONTROLLER = "\t\tUtil::addInitScript('files', 'init');";
const NEW_CONTROLLER = "\t\tUtil::addInitScript('files', 'init-opensuite-tp1');";

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
	requireCount($bundle, OLD_BUNDLE, 1, 'NC34 TemplatePicker loader preimage');
	requireCount($bundle, OLD_FACTORY, 1, 'NC34 vulnerable TemplatePicker factory');
	requireCount($bundle, NEW_BUNDLE, 0, 'patched TemplatePicker loader before transform');
	requireCount($bundle, NEW_FACTORY, 0, 'patched TemplatePicker factory before transform');
	$candidate = str_replace([OLD_BUNDLE, OLD_FACTORY], [NEW_BUNDLE, NEW_FACTORY], $bundle);
	requireCount($candidate, OLD_FACTORY, 0, 'vulnerable TemplatePicker factory after transform');
	requireCount($candidate, NEW_BUNDLE, 1, 'patched TemplatePicker loader');
	requireCount($candidate, NEW_FACTORY, 1, 'patched TemplatePicker factory');
	requireCount($candidate, 'e.default.mixins=[...(e.default.mixins||[]),{mounted:ir}]', 1, 'resolved child mounted readiness mixin');
	requireCount($candidate, 'if(await ar', 1, 'shared readiness await');
	requireCount($candidate, 'this.$refs.picker.open', 1, 'TemplatePicker open forwarding');
	$directives = 0;
	$candidate = preg_replace('/\n\/\/# sourceMappingURL=files-init\.js\.map\?v=[0-9a-f]+\s*$/', "\n", $candidate, 1, $directives);
	if ($candidate === null || $directives !== 1 || str_contains($candidate, 'sourceMappingURL=')) {
		throw new RuntimeException('expected to remove exactly one upstream source-map directive');
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
$chunkPath = "{$dist}/7497-7497.js";
$chunkMapPath = "{$dist}/7497-7497.js.map";
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
		$matches[] = $sourceMap['sourcesContent'][$index];
	}
}
if (count($matches) !== 1) {
	throw new RuntimeException('expected exactly one authoritative newFromTemplate.ts source');
}
requireCount($matches[0], VULNERABLE_SOURCE, 1, 'authoritative vulnerable NC34 source');

$patchedPath = "{$dist}/files-init-opensuite-tp1.js";
$temporaryPath = "{$patchedPath}.tmp";
if (file_put_contents($temporaryPath, transformBundle(readFileStrict($bundlePath))) === false
		|| !rename($temporaryPath, $patchedPath)) {
	throw new RuntimeException('could not atomically publish patched TemplatePicker bundle');
}
if (hash_file('sha256', $patchedPath) !== PATCHED_BUNDLE_SHA256) {
	throw new RuntimeException('patched TemplatePicker bundle hash mismatch');
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
