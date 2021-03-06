"use strict";

const async = require("async");
const formidable = require("formidable");

const db = require("../lib/db");
const record = require("../lib/record");
const models = require("../lib/models");
const options = require("../lib/options");
const metadata = require("../lib/metadata");

module.exports = function(app) {
    const Source = models("Source");
    const Image = models("Image");

    const cache = require("../server/middlewares/cache");
    const search = require("./shared/search-page");
    const auth = require("./shared/auth");

    return {
        search,

        bySource(req, res) {
            try {
                search(req, res, {
                    url: Source.getSource(req.params.source).url,
                });

            } catch (e) {
                return res.status(404).render("Error", {
                    title: req.gettext("Source not found."),
                });
            }
        },

        show(req, res, next) {
            const typeName = req.params.type;

            if (options.types[typeName].alwaysEdit) {
                return res.redirect(`${req.originalUrl}/edit`);
            }

            const Record = record(typeName);
            const compare = ("compare" in req.query);
            const id = `${req.params.source}/${req.params.recordName}`;

            Record.findById(id, (err, record) => {
                if (err || !record) {
                    // We don't return a 404 here to allow this to pass
                    // through to other handlers
                    return next();
                }

                record.loadImages(true, () => {
                    // TODO: Handle error loading images?
                    const title = record.getTitle(req);

                    // Sort the similar records by score
                    record.similarRecords = record.similarRecords
                        .sort((a, b) => b.score - a.score);

                    if (!compare) {
                        return res.render("Record", {
                            title,
                            compare: false,
                            records: [record],
                            similar: record.similarRecords,
                            sources: Source.getSourcesByType(typeName),
                        });
                    }

                    async.eachLimit(record.similarRecords, 4,
                        (similar, callback) => {
                            similar.recordModel.loadImages(false, callback);
                        }, () => {
                            res.render("Record", {
                                title,
                                compare: true,
                                noIndex: true,
                                similar: [],
                                records: [record]
                                    .concat(record.similarRecords
                                        .map((similar) => similar.recordModel)),
                                sources: Source.getSourcesByType(typeName),
                            });
                        });
                });
            });
        },

        edit(req, res) {
            const Record = record(req.params.type);
            const id = `${req.params.source}/${req.params.recordName}`;

            Record.findById(id, (err, record) => {
                if (err || !record) {
                    return res.status(404).render("Error", {
                        title: req.gettext("Not found."),
                    });
                }

                record.loadImages(true, () => {
                    res.render("EditRecord", {
                        record,
                    });
                });
            });
        },

        update(req, res, next) {
            const props = {};
            const type = req.params.type;
            const model = metadata.model(type);
            const hasImageSearch = options.types[type].hasImageSearch();
            const id = req.params.recordName;
            const _id = `${req.params.source}/${id}`;

            const form = new formidable.IncomingForm();
            form.encoding = "utf-8";
            form.maxFieldsSize = options.maxUploadSize;
            form.multiples = true;

            form.parse(req, (err, fields, files) => {
                /* istanbul ignore if */
                if (err) {
                    return next(new Error(
                        req.gettext("Error processing upload.")));
                }

                req.lang = fields.lang;

                for (const prop in model) {
                    props[prop] = fields[prop];
                }

                Object.assign(props, {
                    id,
                    lang: req.lang,
                    source: req.params.source,
                    type,
                });

                const Record = record(type);

                const {data, error} = Record.lintData(props, req);

                if (error) {
                    return next(new Error(error));
                }

                const mockBatch = {
                    _id: db.mongoose.Types.ObjectId().toString(),
                    source: req.params.source,
                };

                const images = Array.isArray(files.images) ?
                    files.images :
                    files.images ?
                        [files.images] :
                        [];

                async.mapSeries(images, (file, callback) => {
                    if (!file.path || file.size <= 0) {
                        return process.nextTick(callback);
                    }

                    Image.fromFile(mockBatch, file, (err, image) => {
                        // TODO: Display better error message
                        if (err) {
                            return callback(
                                new Error(
                                    req.gettext("Error processing image.")));
                        }

                        image.save((err) => {
                            /* istanbul ignore if */
                            if (err) {
                                return callback(err);
                            }

                            callback(null, image);
                        });
                    });
                }, (err, unfilteredImages) => {
                    if (err) {
                        return next(err);
                    }

                    Record.findById(_id, (err, record) => {
                        if (err || !record) {
                            return res.status(404).render("Error", {
                                title: req.gettext("Not found."),
                            });
                        }

                        record.set(data);

                        record.images = record.images.concat(
                            unfilteredImages
                                .filter((image) => image)
                                .map((image) => image._id));

                        record.save((err) => {
                            if (err) {
                                return next(new Error(
                                    req.gettext("Error saving record.")));
                            }

                            const finish = () =>
                                res.redirect(record.getURL(req.lang));

                            if (record.images.length === 0 || !hasImageSearch) {
                                return finish();
                            }

                            // If new images were added then we need to update
                            // their similarity and the similarity of all other
                            // images, as well.
                            Image.queueBatchSimilarityUpdate(mockBatch._id,
                                finish);
                        });
                    });
                });
            });
        },

        removeImage(req, res, next) {
            const type = req.params.type;
            const Record = record(type);
            const hasImageSearch = options.types[type].hasImageSearch();
            const id = `${req.params.source}/${req.params.recordName}`;

            const form = new formidable.IncomingForm();
            form.encoding = "utf-8";

            form.parse(req, (err, fields) => {
                /* istanbul ignore if */
                if (err) {
                    return next(new Error(
                        req.gettext("Error processing request.")));
                }

                const imageID = fields.image;

                req.lang = fields.lang;

                Record.findById(id, (err, record) => {
                    if (err || !record) {
                        return next(new Error(req.gettext("Not found.")));
                    }

                    record.images = record.images
                        .filter((image) => image !== imageID);

                    record.save((err) => {
                        if (err) {
                            return next(new Error(
                                req.gettext("Error saving record.")));
                        }

                        const finish = () =>
                            res.redirect(record.getURL(req.lang));

                        if (!hasImageSearch) {
                            return finish();
                        }

                        record.updateSimilarity(finish);
                    });
                });
            });
        },

        createView(req, res) {
            res.render("CreateRecord", {
                type: req.params.type,
            });
        },

        create(req, res, next) {
            const props = {};
            const type = req.params.type;
            const model = metadata.model(type);
            const hasImageSearch = options.types[type].hasImageSearch();

            const form = new formidable.IncomingForm();
            form.encoding = "utf-8";
            form.maxFieldsSize = options.maxUploadSize;
            form.multiples = true;

            form.parse(req, (err, fields, files) => {
                /* istanbul ignore if */
                if (err) {
                    return next(new Error(
                        req.gettext("Error processing upload.")));
                }

                req.lang = fields.lang;

                for (const prop in model) {
                    props[prop] = fields[prop];
                }

                if (options.types[type].autoID) {
                    props.id = db.mongoose.Types.ObjectId().toString();
                } else {
                    props.id = fields.id;
                }

                Object.assign(props, {
                    lang: req.lang,
                    source: req.params.source,
                    type,
                });

                const Record = record(type);

                const {data, error} = Record.lintData(props, req);

                if (error) {
                    return next(new Error(error));
                }

                const newRecord = new Record(data);

                const mockBatch = {
                    _id: db.mongoose.Types.ObjectId().toString(),
                    source: newRecord.source,
                };

                const images = Array.isArray(files.images) ?
                    files.images :
                    files.images ?
                        [files.images] :
                        [];

                async.mapSeries(images, (file, callback) => {
                    if (!file.path || file.size <= 0) {
                        return process.nextTick(callback);
                    }

                    Image.fromFile(mockBatch, file, (err, image) => {
                        // TODO: Display better error message
                        if (err) {
                            return callback(
                                new Error(
                                    req.gettext("Error processing image.")));
                        }

                        image.save((err) => {
                            /* istanbul ignore if */
                            if (err) {
                                return callback(err);
                            }

                            callback(null, image);
                        });
                    });
                }, (err, unfilteredImages) => {
                    if (err) {
                        return next(err);
                    }

                    newRecord.images = unfilteredImages
                        .filter((image) => image)
                        .map((image) => image._id);

                    newRecord.save((err) => {
                        if (err) {
                            return next(new Error(
                                req.gettext("Error saving record.")));
                        }

                        const finish = () =>
                            res.redirect(newRecord.getURL(req.lang));

                        if (newRecord.images.length === 0 || !hasImageSearch) {
                            return finish();
                        }

                        // If new images were added then we need to update
                        // their similarity and the similarity of all other
                        // images, as well.
                        Image.queueBatchSimilarityUpdate(mockBatch._id, finish);
                    });
                });
            });
        },

        routes() {
            app.get("/search", cache(1), this.search);
            app.get("/:type/search", cache(1), this.search);
            app.get("/source/:source", cache(1), this.bySource);
            app.get("/:type/source/:source", cache(1), this.bySource);
            app.get("/:type/:source/create", auth, this.createView);
            app.post("/:type/:source/create", auth, this.create);

            for (const typeName in options.types) {
                const searchURLs = options.types[typeName].searchURLs;
                for (const path in searchURLs) {
                    app.get(`/:type${path}`, cache(1), (req, res) =>
                        searchURLs[path](req, res, search));
                }
            }

            // Handle these last as they'll catch almost anything
            app.get("/:type/:source/:recordName/edit", auth, this.edit);
            app.post("/:type/:source/:recordName/edit", auth, this.update);
            app.post("/:type/:source/:recordName/remove-image", auth,
                this.removeImage);
            app.get("/:type/:source/:recordName", this.show);
        },
    };
};
