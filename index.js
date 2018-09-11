const through = require('through2'),
    babel = require("babel-core"),
    _ = require('underscore'),
    fs = require('fs-extra'),
    path = require('path'),
    md5 = require('md5'),
    gutil = require('gulp-util'),
    ugJs = require("uglify-js"),
    ugCss = require('uglifycss'),
    less = require("less"),
    PluginError = gutil.PluginError;

// PLUGIN_NAME
const PLUGIN_NAME = 'gulp-blade-extend';

// Main function
function gulpBladeExtend(options = {}) {
    _.defaults(options, {
        jsDistPath: null,   //js output path
        cssDistPath: null,   //css output path
        bladeDistPath: null, //blade output path
        minify: false,  //compression
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
    return through.obj(function (file, enc, cb) {
        const $this = this;
        if (file.isNull()) {
            this.push(file);
            return cb();
        }

        if (file.isStream()) {
            this.emit('error', new PluginError(PLUGIN_NAME, 'Streams are not supported!'));
            return cb();
        }

        if (file.isBuffer()) {
            const bladeRelativePath = path.relative(path.resolve('resources/views'), file.path);
            let content = file.contents.toString();

            const currentBladeMd5 = String(md5(content + options.version));
            const md5Recorder = path.join(options.bladeDistPath, bladeRelativePath) + '.md5';
            fs.ensureFileSync(md5Recorder);
            const md5Record = fs.readFileSync(md5Recorder, "utf-8");

            if (md5Record.toUpperCase() !== currentBladeMd5.toUpperCase()) {
                console.log(bladeRelativePath);
                const cssExp = /<style\s+data-inside.*?>([\s\S]*?)<\/style>/gi;
                const cssResult = cssExp.exec(content);
                if (cssResult !== null) {
                    const cssFileName = md5(bladeRelativePath) + '.css';
                    const cssImportPath = options.cssDistPath + '/' + cssFileName + '?v=' + currentBladeMd5;
                    content = content.replace(cssExp, options.cssImport.replace(/\$path/i, cssImportPath));

                    let cssFinalContent = cssResult[1];
                    less.render(cssFinalContent, function (e, output) {
                        let css = output.css;
                        if (options.minify) {
                            css = ugCss.processString(css);
                        }
                        fs.outputFileSync(path.join("public/", options.cssDistPath, cssFileName), css);
                    });
                }


                const cssSameExp = /<style\s+data-same="(.*?)"><\/style>/gi;
                const cssSameResult = cssSameExp.exec(content);
                if (cssSameResult !== null) {
                    let sameBabelRelativePath = cssSameResult[1];
                    if (!sameBabelRelativePath.endsWith('.blade.php')) {
                        sameBabelRelativePath += '.blade.php';
                    }
                    const sameBabelRealPath = path.resolve(path.dirname(file.path), sameBabelRelativePath);
                    const bladeRelativePath = path.relative(path.resolve('resources/views'), sameBabelRealPath);
                    const cssFileName = md5(bladeRelativePath) + '.css';
                    const cssImportPath = options.cssDistPath + '/' + cssFileName + '?v=' + currentBladeMd5;
                    content = content.replace(cssSameExp, options.cssImport.replace(/\$path/i, cssImportPath));
                }


                const scriptExp = /<script\s+data-inside>([\s\S]*?)<\/script>/gi;
                const scriptResult = scriptExp.exec(content);
                if (scriptResult !== null) {
                    const jsFileName = md5(bladeRelativePath) + '.js';
                    const jsImportPath = options.jsDistPath + '/' + jsFileName + '?v=' + currentBladeMd5;
                    content = content.replace(scriptExp, options.jsImport.replace(/\$path/i, jsImportPath));

                    const jsContent = scriptResult[1];
                    const vm = require("vm");
                    const sandbox = {
                        exports: {
                            include: [],
                            init: null,
                            main: null,
                        }
                    };
                    vm.createContext(sandbox);
                    vm.runInContext(jsContent, sandbox);

                    let mainFunctionString = "";
                    if (_.isFunction(sandbox.exports.init)) {
                        mainFunctionString += '(' + sandbox.exports.init.toString() + ')();\n\n';
                    }

                    if (_.isFunction(sandbox.exports.main)) {
                        mainFunctionString += '$(' + sandbox.exports.main.toString() + ');';
                    }
                    const trans = babel.transform(mainFunctionString, {
                        presets: 'es2015',
                        plugins: ["transform-regenerator"]
                    });

                    let jsContents = [];
                    sandbox.exports.include.forEach((includeFile, index) => {
                        try {
                            let originalCode = fs.readFileSync(includeFile, 'utf8');
                            if (options.minify) {
                                originalCode = ugJs.minify(originalCode, {
                                    fromString: true,
                                    compress: false,
                                    mangle: false
                                }).code;
                            }
                            jsContents.push(originalCode);
                        } catch (error) {
                            $this.emit('error', new PluginError(PLUGIN_NAME, `${error.toString()} in ${file.path}`));
                            return cb();
                        }
                    });
                    let jsFinalTransCode = trans.code;
                    if (options.minify) {
                        jsFinalTransCode = ugJs.minify(jsFinalTransCode, {fromString: true}).code;
                    }
                    jsContents.push(jsFinalTransCode);

                    const jsFinalContent = jsContents.join('\n');
                    fs.outputFileSync(path.join("public/", options.jsDistPath, jsFileName), jsFinalContent);
                }

                const scriptSameExp = /<script\s+data-same="(.*?)"><\/script>/gi;
                const scriptSameResult = scriptSameExp.exec(content);
                if (scriptSameResult !== null) {
                    let sameBabelRelativePath = scriptSameResult[1];
                    if (!sameBabelRelativePath.endsWith('.blade.php')) {
                        sameBabelRelativePath += '.blade.php';
                    }
                    const sameBabelRealPath = path.resolve(path.dirname(file.path), sameBabelRelativePath);
                    const bladeRelativePath = path.relative(path.resolve('resources/views'), sameBabelRealPath);
                    const jsFileName = md5(bladeRelativePath) + '.js';
                    const jsImportPath = options.jsDistPath + '/' + jsFileName + '?v=' + currentBladeMd5;
                    content = content.replace(scriptSameExp, options.jsImport.replace(/\$path/i, jsImportPath));
                }

                //Remove excess indentations
                content = content.replace(/\/\/@[$\n\r]/ig, '');
                //Remove IDEA @formatter mark
                content = content.replace(/{{--\s*@formatter:\S+\s*--}}\n?/ig, '');
                //Remove HTML comment
                content = content.replace(/<!--[^\[][\s\S]*?-->\n?/ig, '');

                //Write new content to file
                file.contents = new Buffer(content);

                fs.outputFileSync(md5Recorder, currentBladeMd5);
            } else {
                //Don't forget to let the unmodified file also get the Buffer of the previous version of the compiled file.
                const targetFile = path.join(options.bladeDistPath, bladeRelativePath);
                file.contents = fs.readFileSync(targetFile);
            }
        }

        // Put the file into next gulp plugin
        this.push(file);

        // Finished
        cb();
    });
}

// Export the main function
module.exports = gulpBladeExtend;