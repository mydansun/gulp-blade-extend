const through = require('through2'),
    babel = require("babel-core"),
    _ = require('underscore'),
    fs = require('fs-extra'),
    path = require('path'),
    md5 = require('md5'),
    ugJs = require("uglify-js"),
    ugCss = require('uglifycss'),
    less = require("less"),
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
            const bladeRelativePath = path.relative(path.resolve(options.bladeSrcPath), file.path);
            let fileContent = file.contents.toString();
            const fileContentInBase64 = Buffer.from(fileContent).toString('base64');

            const currentBladeMd5 = String(md5(fileContentInBase64 + options.version));
            const targetOriginalBlade = path.join(options.bladeDistPath, bladeRelativePath) + ".src";
            let targetOriginalBladeMd5 = "";
            if (fs.existsSync(targetOriginalBlade)) {
                targetOriginalBladeMd5 = String(md5(fs.readFileSync(targetOriginalBlade, "utf-8") + options.version));
            }

            if (targetOriginalBladeMd5.toUpperCase() !== currentBladeMd5.toUpperCase()) {
                console.log(`Compiling ${bladeRelativePath}`);
                fs.outputFileSync(targetOriginalBlade, fileContentInBase64)
                const cssExp = /<style\s+data-scoped(.*?)>([\s\S]*?)<\/style>/gi;
                const cssResult = cssExp.exec(fileContent);
                if (cssResult !== null) {
                    const cssFileName = md5(bladeRelativePath) + '.css';
                    const cssImportPath = options.cssDistPath + '/' + cssFileName + '?v=' + currentBladeMd5;
                    fileContent = fileContent.replace(cssExp, options.cssImport.replace(/\$path/i, cssImportPath));

                    const cssAttributes = cssResult[1];
                    const cssContent = cssResult[2];
                    if (cssAttributes.indexOf("text/less") !== -1) {
                        less.render(cssContent, function (e, output) {
                            let css = output.css;
                            if (options.minify) {
                                css = ugCss.processString(css);
                            }
                            fs.outputFileSync(path.join("public/", options.cssDistPath, cssFileName), css);
                        });
                    }
                }

                const cssSameExp = /<style\s+data-import="(.*?)"><\/style>/gi;
                const cssSameResult = cssSameExp.exec(fileContent);
                if (cssSameResult !== null) {
                    let sameBabelRelativePath = cssSameResult[1];
                    if (!sameBabelRelativePath.endsWith('.blade.php')) {
                        sameBabelRelativePath += '.blade.php';
                    }
                    const sameBabelRealPath = path.resolve(path.dirname(file.path), sameBabelRelativePath);
                    const bladeRelativePath = path.relative(path.resolve('resources/views'), sameBabelRealPath);
                    const cssFileName = md5(bladeRelativePath) + '.css';
                    const cssImportPath = options.cssDistPath + '/' + cssFileName + '?v=' + currentBladeMd5;
                    fileContent = fileContent.replace(cssSameExp, options.cssImport.replace(/\$path/i, cssImportPath));
                }


                const scriptExp = /<script\s+data-scoped>([\s\S]*?)<\/script>/gi;
                const scriptResult = scriptExp.exec(fileContent);
                if (scriptResult !== null) {
                    const jsFileName = md5(bladeRelativePath) + '.js';
                    const jsImportPath = options.jsDistPath + '/' + jsFileName + '?v=' + currentBladeMd5;
                    fileContent = fileContent.replace(scriptExp, options.jsImport.replace(/\$path/i, jsImportPath));

                    const jsContent = scriptResult[1];
                    const vm = require("vm");
                    const sandbox = {
                        exports: {
                            include: [],
                            init: null,
                            ready: null,
                        }
                    };
                    vm.createContext(sandbox);
                    try {
                        vm.runInContext(jsContent, sandbox);
                    } catch (error) {
                        $this.emit('error', new PluginError(PLUGIN_NAME, `${error.toString()} in ${file.path}`));
                        return callback();
                    }

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
                    sandbox.exports.include.forEach((includeFile, index) => {
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
                            $this.emit('error', new PluginError(PLUGIN_NAME, `${error.toString()} in ${file.path}`));
                            return callback();
                        }
                    });
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
                    let sameBabelRelativePath = scriptSameResult[1];
                    if (!sameBabelRelativePath.endsWith('.blade.php')) {
                        sameBabelRelativePath += '.blade.php';
                    }
                    const sameBabelRealPath = path.resolve(path.dirname(file.path), sameBabelRelativePath);
                    const bladeRelativePath = path.relative(path.resolve('resources/views'), sameBabelRealPath);
                    const jsFileName = md5(bladeRelativePath) + '.js';
                    const jsImportPath = options.jsDistPath + '/' + jsFileName + '?v=' + currentBladeMd5;
                    fileContent = fileContent.replace(scriptSameExp, options.jsImport.replace(/\$path/i, jsImportPath));
                }

                //Remove excess indentations
                fileContent = fileContent.replace(/\/\/@[$\n\r]/ig, '');
                //Remove IDEA @formatter mark
                fileContent = fileContent.replace(/{{--\s*@formatter:\S+\s*--}}\n?/ig, '');
                //Remove HTML comment
                fileContent = fileContent.replace(/<!--[^\[][\s\S]*?-->\n?/ig, '');

                //Write new content to file
                file.contents = new Buffer(fileContent);
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