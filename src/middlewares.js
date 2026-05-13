/*
Copyright 2024 dimden.dev

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

const fs = require('fs');
const path = require('path');
const bytes = require('bytes');
const zlib = require('fast-zlib');
const typeis = require('type-is');
const querystring = require('fast-querystring');
const { AsyncResource } = require('async_hooks');
const { fastQueryParse, NullObject } = require('./utils.js');

function static(root, options) {
    if(!options) options = new NullObject();
    if(typeof options.index === 'undefined') options.index = 'index.html';
    if(typeof options.redirect === 'undefined') options.redirect = true;
    if(typeof options.fallthrough === 'undefined') options.fallthrough = true;
    if(typeof options.dotfiles === 'undefined') options.dotfiles = 'ignore_files';
    if(options.extensions) {
        if(typeof options.extensions !== 'string' && !Array.isArray(options.extensions)) {
            throw new Error('extensions must be a string or an array');
        }
        if(!Array.isArray(options.extensions)) {
            options.extensions = [options.extensions];
        }
        options.extensions = options.extensions.map(ext => ext.startsWith('.') ? ext.slice(1) : ext);
    }
    options.root = root;

    return (req, res, next) => {
        const iq = req.url.indexOf('?');
        let url;

        next = AsyncResource.bind(next);

        try {
            url = decodeURIComponent(iq !== -1 ? req.url.substring(0, iq) : req.url);
        } catch(e) {
            if(!options.fallthrough) {
                res.status(404);
                return next(new Error('Not found'));
            } else return next();
        }
        let _path = url;
        let fullpath = path.resolve(path.join(options.root, url));
        if(options.root && !fullpath.startsWith(path.resolve(options.root))) {
            if(!options.fallthrough) {
                res.status(403);
                return next(new Error('Forbidden'));
            } else return next();
        }

        let stat;
        try {
            stat = fs.statSync(fullpath);
        } catch(err) {
            const ext = path.extname(fullpath);
            let i = 0;
            if(ext === '' && options.extensions) {
                while(i < options.extensions.length) {
                    try {
                        stat = fs.statSync(fullpath + '.' + options.extensions[i]);
                        _path = url + '.' + options.extensions[i];
                        break;
                    } catch(err) {
                        i++;
                    }
                }
            }
            if(!stat) {
                if(!options.fallthrough) {
                    res.status(404);
                    return next(err.message);
                } else return next();
            }
        }

        if(stat.isDirectory()) {
            if(!req.endsWithSlash) {
                if(options.redirect) {
                    return res.redirect(301, req._originalPath + '/', true);
                } else {
                    if(!options.fallthrough) {
                        res.status(404);
                        return next(new Error('Not found'));
                    } else return next();
                }
            }
            if(options.index) {
                try {
                    stat = fs.statSync(path.join(fullpath, options.index));
                    _path = path.join(url, options.index);
                } catch(err) {
                    if(!options.fallthrough) {
                        res.status(404);
                        return next(new Error('Not found'));
                    } else return next();
                }
            } else {

                return next();
            }
        }

        options._stat = stat;

        return res.sendFile(_path, options, e => {
            if(e) {
                next(!options.fallthrough ? e : undefined);
            }
        });
    }
}

function createInflate(contentEncoding) {
    const encoding = (contentEncoding || 'identity').toLowerCase();
    switch(encoding) {
        case 'identity':
            return;
        case 'deflate':
            return new zlib.Inflate();
        case 'gzip':
            return new zlib.Gunzip();
        case 'br':
            return new zlib.BrotliDecompress();
        default:
            return false;
    }
}

function createBodyParser(defaultType, beforeReturn) {
    return function(options) {
        if(typeof options !== 'object') {
            options = new NullObject();
        }
        if(typeof options.limit === 'undefined') options.limit = bytes('100kb');
        else options.limit = bytes(options.limit);

        if(typeof options.inflate === 'undefined') options.inflate = true;
        if(typeof options.type === 'undefined') options.type = defaultType;
        if(typeof options.type === 'string') {
            if(!options.type.includes("*")) {
                options.simpleType = options.type;
            }
            options.type = [options.type];
        } else if(typeof options.type !== 'function' && !Array.isArray(options.type)) {
            throw new Error('type must be a string, function or an array');
        }
        if(typeof options.defaultCharset === 'undefined') options.defaultCharset = 'utf-8';

        let additionalMethods;

        return (req, res, next) => {
            next = AsyncResource.bind(next);
            
            // skip reading body twice
            if(req.bodyRead) {
                return next();
            }

            const type = req.headers['content-type'];

            if(!req.body) req.body = new NullObject();

            // skip reading body for no content type
            if(!type) {
                return next();
            }

            const length = req.headers['content-length'];
            // skip reading empty body
            if(length == '0') {
                return next();
            }

            if(options.simpleType) {
                const semicolonIndex = type.indexOf(';');
                const clearType = semicolonIndex !== -1 ? type.substring(0, semicolonIndex) : type;
                if(clearType !== options.simpleType) {
                    return next();
                }
            } else {
                if(typeof options.type === 'function') {
                    if(!options.type(req)) {
                        return next();
                    }
                } else {
                    if(!typeis(req, options.type)) {
                        return next();
                    }
                }
            }

            // skip reading too large body
            if(length && +length > options.limit) {
                return next(new Error('Request entity too large'));
            }


            // skip reading body for non-POST requests
            // this makes it +10k req/sec faster
            if(additionalMethods === undefined) additionalMethods = req.app.get('body methods') ?? null;
            if(
                req.method !== 'POST' &&
                req.method !== 'PUT' &&
                req.method !== 'PATCH' && 
                (!additionalMethods || !additionalMethods.includes(req.method))
            ) {
                return next();
            }

            let inflate;
            if(options.inflate) {
                inflate = createInflate(req.headers['content-encoding']);
                if(inflate === false) {
                    return next(new Error('Unsupported content encoding'));
                }
            }

            req.bodyRead = true;

            // Streaming fallback. Used when:
            //   - inflate is active: post-decompression size is unknown, so we
            //     can't pre-allocate based on maxRemainingBodyLength.
            //   - req.receivedData is true: an upstream async middleware caused
            //     request.js's onDataV2 handler to fire and push chunks into
            //     the Readable queue before this middleware ran.
            if(inflate || req.receivedData) {
                const abs = [];
                let totalSize = 0;

                function onData(buf) {
                    if(res.finished || res.aborted) return;
                    if(!Buffer.isBuffer(buf)) {
                        buf = Buffer.from(buf);
                    }
                    if(inflate) {
                        buf = inflate.process(buf);
                    }
                    abs.push(buf);
                    totalSize += buf.length;
                    if(totalSize > options.limit) {
                        return next(new Error('Request entity too large'));
                    }
                }

                function onEnd() {
                    const buf = Buffer.concat(abs);
                    if(options.verify) {
                        try {
                            options.verify(req, res, buf);
                        } catch(e) {
                            return next(e);
                        }
                    }
                    beforeReturn(req, res, next, options, buf);
                }

                if(req.receivedData) {
                    req.on('data', onData);
                    req.on('end', onEnd);
                } else {
                    req._res.onDataV2((ab, maxRemainingBodyLength) => {
                        const isLast = maxRemainingBodyLength === 0n;
                        // slice(0) detaches bytes from uWS-owned ab (neutered after this callback)
                        onData(ab.slice(0));
                        if(isLast && !res.finished && !res.aborted) {
                            onEnd();
                        }
                    });
                }
                return;
            }

            // Pre-alloc fast path: one Buffer.allocUnsafe(predicted) up front
            // using uWS's maxRemainingBodyLength hint and copy each chunk
            // straight into it. One copy per chunk, no per-chunk Buffer
            // allocation, no final Buffer.concat.
            let buffer = null;
            let offset = 0;

            req._res.onDataV2((ab, maxRemainingBodyLength) => {
                if(res.finished || res.aborted) return;

                const chunkLen = ab.byteLength;

                if(buffer === null) {
                    // First chunk: uWS hints the predicted total via
                    // maxRemainingBodyLength. The upfront Content-Length check
                    // earlier in the handler rejects oversize bodies when the
                    // header is present; this second check covers chunked
                    // transfer encoding (no Content-Length) and clients that
                    // under-report it.
                    const total = chunkLen + Number(maxRemainingBodyLength);
                    if(total > options.limit) {
                        return next(new Error('Request entity too large'));
                    }
                    buffer = Buffer.allocUnsafe(total);
                }

                const newOffset = offset + chunkLen;

                // Per-chunk limit guard. maxRemainingBodyLength is a maximum,
                // not exact — protect against an under-reporting client
                // overflowing the buffer.
                if(newOffset > options.limit) {
                    return next(new Error('Request entity too large'));
                }

                // Defensive grow if the prediction was too small.
                if(newOffset > buffer.length) {
                    const grown = Buffer.allocUnsafe(newOffset);
                    buffer.copy(grown, 0, 0, offset);
                    buffer = grown;
                }

                buffer.set(new Uint8Array(ab), offset);
                offset = newOffset;

                if(maxRemainingBodyLength === 0n) {
                    if(res.finished || res.aborted) return;
                    // subarray, never the raw allocUnsafe buffer — when the
                    // actual body is smaller than the prediction the trailing
                    // bytes are uninitialized heap memory.
                    const body = buffer.subarray(0, offset);
                    if(options.verify) {
                        try {
                            options.verify(req, res, body);
                        } catch(e) {
                            return next(e);
                        }
                    }
                    beforeReturn(req, res, next, options, body);
                }
            });
        }
    }
}

const json = createBodyParser('application/json', function(req, res, next, options, buf) {
    if(options.strict) {
        if(req.body && typeof req.body !== 'object') {
            return next(new Error('Invalid body'));
        }
    }
    if(buf.length === 0) {
        req.body = {};
        return next();
    }
    try {
        req.body = JSON.parse(buf.toString(), options.reviver);
    } catch(e) {
        return next(e);
    }

    next();
});

const raw = createBodyParser('application/octet-stream', function(req, res, next, options, buf) {
    req.body = buf;
    next();
});

const text = createBodyParser('text/plain', function(req, res, next, options, buf) {
    let contentType = req.headers['content-type'];
    let charsetIndex = contentType.indexOf('charset=');
    let encoding = options.defaultCharset;
    if(charsetIndex !== -1) {
        encoding = contentType.substring(charsetIndex + 8);
        const semicolonIndex = encoding.indexOf(';');
        if(semicolonIndex !== -1) {
            encoding = encoding.substring(0, semicolonIndex);
        }
        encoding = encoding.trim().toLowerCase();
    }
    if(encoding !== 'utf-8' && encoding !== 'utf-16le' && encoding !== 'latin1') {
        return next(new Error('Unsupported charset'));
    }
    try {
        req.body = buf.toString(encoding);
    } catch(e) {
        return next(e);
    }

    next();
});

const urlencoded = createBodyParser('application/x-www-form-urlencoded', function(req, res, next, options, buf) {
    try {
        if(options.extended) {
            req.body = fastQueryParse(buf.toString(), options);
        } else {
            req.body = querystring.parse(buf.toString());
        }
    } catch(e) {
        return next(e);
    }
    next();
});

module.exports = {
    static,
    json,
    raw,
    text,
    urlencoded,
};
