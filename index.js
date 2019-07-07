const through = require('through2'),
    babel = require("babel-core"),
    _ = require('underscore'),
    fs = require('fs-extra'),
    path = require('path'),
    md5 = require('md5'),
    ugJs = require("uglify-js"),
    ugCss = require('uglifycss'),
    sass = require("node-sass"),
    PluginError = require('plugin-error');

// PLUGIN_NAME
const PLUGIN_NAME = 'gulp-blade-extend';

// Main function
function gulpBladeExtend(options = {}) {
    _.defaults(options, {
        jsDistPath: null,   // js output path
        cssDistPath: null,   // css output path
        bladeSrcPath: 'resources/views', // blade source path
        bladeDistPath: null, // blade output path
        minify: false,  // enable compression?
        version: "",

        resourceInclude: `
        @include('$path')
        `,

        //js blade template
        jsImport: `
        @push('scripts')
            <script src="{{ asset('$path') }}"></script>
        @endpush
        `,

        //css blade template
        cssImport: `
        @push('css')
            <link href="{{ asset('$path') }}" rel="stylesheet" type="text/css">
        @endpush
        `,
    });

    if (_.isEmpty(options.jsDistPath)) {
        throw new PluginError(PLUGIN_NAME, 'Missing jsDistPath option!');
    }

    if (_.isEmpty(options.cssDistPath)) {
        throw new PluginError(PLUGIN_NAME, 'Missing cssDistPath option!');
    }

    // Create a new stream
    return through.obj(function (file, encoding, callback) {
        const $this = this;
        const originalFilePath = file.path;
        const originalBladeName = path.basename(file.path, ".blade.php");
        let hasCss = false;
        let hasJs = false;
        let cssLoader = "";
        let jsLoader = "";

        if (file.isNull()) {
            this.push(file);
            // nothing to do
            return callback(null, file);
        }

        if (file.isStream()) {
            this.emit('error', new PluginError(PLUGIN_NAME, 'Streams not supported!'));
            return callback();
        }

        if (file.isBuffer()) {
            const bladeRelativePath = path.relative(path.resolve(options.bladeSrcPath), originalFilePath);
            let fileContent = file.contents.toString();

            const currentBladeMd5 = String(md5(fileContent + options.version));
            const md5File = path.join(options.bladeDistPath, bladeRelativePath) + '.md5';
            const cssLoaderFile = path.join(options.bladeDistPath, path.dirname(bladeRelativePath), originalBladeName + "__css.blade.php");
            const jsLoaderFile = path.join(options.bladeDistPath, path.dirname(bladeRelativePath), originalBladeName + "__js.blade.php");
            //console.log("cssLoaderFile", cssLoaderFile);
            //console.log("jsLoaderFile", jsLoaderFile);

            fs.ensureFileSync(md5File);
            const previousBladeMd5 = fs.readFileSync(md5File, "utf-8");

            if (previousBladeMd5.toLowerCase() !== currentBladeMd5.toLowerCase()) {
                console.log(`Compiling ${bladeRelativePath}`);
                const cssExp = /<style\s+data-scoped(.*?)>([\s\S]*?)<\/style>/gi;
                const cssResult = cssExp.exec(fileContent);

                if (cssResult !== null) {
                    hasCss = true;

                    const cssFileName = md5(bladeRelativePath) + '.css';
                    const cssImportPath = options.cssDistPath + '/' + cssFileName + '?v=' + currentBladeMd5;
                    fileContent = fileContent.replace(cssExp, "");
                    cssLoader = cssLoader + "\n" + options.cssImport.replace(/\$path/i, cssImportPath);

                    const cssAttributes = cssResult[1];
                    let cssContent = cssResult[2];

                    if (cssAttributes.indexOf("text/scss") !== -1) {
                        const result = sass.renderSync({
                            data: cssContent,
                        });
                        cssContent = result.css;
                        if (options.minify) {
                            cssContent = ugCss.processString(cssContent);
                        }
                    } else {
                        if (options.minify) {
                            cssContent = ugCss.processString(cssContent);
                        }
                    }
                    fs.outputFileSync(path.join("public/", options.cssDistPath, cssFileName), cssContent);
                }


                const cssSameExp = /<style\s+data-import="(.*?)"><\/style>/gi;
                const cssSameResult = cssSameExp.exec(fileContent);
                if (cssSameResult !== null) {
                    hasCss = true;
                    let importBabelRelativePath = cssSameResult[1];
                    if (!importBabelRelativePath.endsWith('.blade.php')) {
                        importBabelRelativePath += '.blade.php';
                    }
                    const importBabelRealPath = path.resolve(path.dirname(originalFilePath), importBabelRelativePath);
                    const bladeRelativePath = path.relative(options.bladeSrcPath, importBabelRealPath);

                    const loaderBladeName = path.basename(importBabelRelativePath, ".blade.php");
                    const loaderLoadPath = path.join(path.dirname(bladeRelativePath), loaderBladeName).split(path.sep).join('.');

                    fileContent = fileContent.replace(cssSameExp, "");
                    cssLoader = cssLoader + "\n" + options.resourceInclude.replace(/\$path/i, loaderLoadPath + "__css");
                }

                const scriptExp = /<script\s+data-scoped>([\s\S]*?)<\/script>/gi;
                const scriptResult = scriptExp.exec(fileContent);
                if (scriptResult !== null) {
                    hasJs = true;
                    const jsFileName = md5(bladeRelativePath) + '.js';
                    const jsImportPath = options.jsDistPath + '/' + jsFileName + '?v=' + currentBladeMd5;

                    const jsContent = scriptResult[1];
                    const vm = require("vm");
                    const sandbox = {
                        exports: {
                            required: [],
                            include: [],
                            init: null,
                            ready: null,
                        }
                    };
                    vm.createContext(sandbox);
                    try {
                        vm.runInContext(jsContent, sandbox);
                    } catch (error) {
                        $this.emit('error', new PluginError(PLUGIN_NAME, `${error.toString()} in ${originalFilePath}`));
                        return callback();
                    }

                    let jsImportContent = options.jsImport.replace(/\$path/i, jsImportPath);
                    let jsRequireContent = "";
                    for (const requiredFile of sandbox.exports.required) {
                        jsRequireContent = jsRequireContent + "\n" + options.jsImport.replace(/\$path/i, requiredFile);
                    }
                    jsImportContent = jsRequireContent + "\n" + jsImportContent;
                    fileContent = fileContent.replace(scriptExp, "");
                    jsLoader = jsLoader + "\n" + jsImportContent;

                    let mainFunctionString = "";
                    if (_.isFunction(sandbox.exports.init)) {
                        mainFunctionString += '(' + sandbox.exports.init.toString() + ')();\n\n';
                    }

                    if (_.isFunction(sandbox.exports.ready)) {
                        mainFunctionString += '$(' + sandbox.exports.ready.toString() + ');';
                    }
                    const trans = babel.transform(mainFunctionString, {
                        presets: ["env"],
                        plugins: ["transform-regenerator"]
                    });

                    let jsContents = [];
                    for (const includeFile of sandbox.exports.include) {
                        try {
                            let originalCode = fs.readFileSync(includeFile, 'utf8');
                            if (options.minify) {
                                originalCode = ugJs.minify(originalCode, {
                                    compress: false,
                                    mangle: false
                                }).code;
                            }
                            jsContents.push(originalCode);
                        } catch (error) {
                            $this.emit('error', new PluginError(PLUGIN_NAME, `${error.toString()} in ${originalFilePath}`));
                            return callback();
                        }
                    }
                    let jsFinalTransCode = trans.code;
                    if (options.minify) {
                        jsFinalTransCode = ugJs.minify(jsFinalTransCode).code;
                    }
                    jsContents.push(jsFinalTransCode);

                    const jsFinalContent = jsContents.join('\n');
                    fs.outputFileSync(path.join("public/", options.jsDistPath, jsFileName), jsFinalContent);
                }

                const scriptSameExp = /<script\s+data-import="(.*?)"><\/script>/gi;
                const scriptSameResult = scriptSameExp.exec(fileContent);
                if (scriptSameResult !== null) {
                    hasJs = true;
                    let importBabelRelativePath = scriptSameResult[1];
                    if (!importBabelRelativePath.endsWith('.blade.php')) {
                        importBabelRelativePath += '.blade.php';
                    }
                    const importBabelRealPath = path.resolve(path.dirname(originalFilePath), importBabelRelativePath);
                    const bladeRelativePath = path.relative(options.bladeSrcPath, importBabelRealPath);

                    const loaderBladeName = path.basename(importBabelRelativePath, ".blade.php");
                    const loaderLoadPath = path.join(path.dirname(bladeRelativePath), loaderBladeName).split(path.sep).join('.');

                    fileContent = fileContent.replace(scriptSameExp, "");
                    jsLoader = jsLoader + "\n" + options.resourceInclude.replace(/\$path/i, loaderLoadPath + "__js");
                }

                //Remove excess indentations
                fileContent = fileContent.replace(/\/\/@[$\n\r]/ig, '');
                fileContent = fileContent.replace(/@void[$\n\r]/ig, '');

                //Remove IDEA @formatter mark
                fileContent = fileContent.replace(/{{--\s*@formatter:\S+\s*--}}\n?/ig, '');
                //Remove HTML comment
                fileContent = fileContent.replace(/<!--[^\[][\s\S]*?-->\n?/ig, '');

                if (hasCss) {
                    fs.outputFileSync(cssLoaderFile, cssLoader);
                    const relativePath = path.relative(options.bladeDistPath, cssLoaderFile)
                    const loaderBladeName = path.basename(relativePath, ".blade.php");
                    const loaderLoadPath = path.join(path.dirname(relativePath), loaderBladeName).split(path.sep).join('.');
                    //console.log("cssLoader-relativePath", loaderLoadPath);
                    fileContent = fileContent + "\n" + options.resourceInclude.replace(/\$path/i, loaderLoadPath);
                } else {
                    fs.outputFileSync(cssLoaderFile, "");
                }
                if (hasJs) {
                    fs.outputFileSync(jsLoaderFile, jsLoader);
                    const relativePath = path.relative(options.bladeDistPath, jsLoaderFile)
                    const loaderBladeName = path.basename(relativePath, ".blade.php");
                    const loaderLoadPath = path.join(path.dirname(relativePath), loaderBladeName).split(path.sep).join('.');
                    //console.log("jsLoader-relativePath", loaderLoadPath);
                    fileContent = fileContent + "\n" + options.resourceInclude.replace(/\$path/i, loaderLoadPath);
                } else {
                    fs.outputFileSync(jsLoaderFile, "");
                }

                //Write new content to file
                file.contents = new Buffer(fileContent);

                fs.outputFileSync(md5File, currentBladeMd5);
            } else {
                //Don't forget to let the unmodified file also get the Buffer of the previous version of the compiled file.
                const targetFile = path.join(options.bladeDistPath, bladeRelativePath);
                file.contents = fs.readFileSync(targetFile);
            }
        }

        // Put the file into next gulp plugin
        this.push(file);

        // Finished
        callback();
    });
}

// Export the main function
module.exports = gulpBladeExtend;