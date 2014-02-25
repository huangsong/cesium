/*global define*/
define(['../Core/Color',
        '../Core/ColorGeometryInstanceAttribute',
        '../Core/defined',
        '../Core/AssociativeArray',
        '../Core/ShowGeometryInstanceAttribute',
        '../Scene/Primitive',
        '../Scene/PrimitiveState'
    ], function(
        Color,
        ColorGeometryInstanceAttribute,
        defined,
        AssociativeArray,
        ShowGeometryInstanceAttribute,
        Primitive,
        PrimitiveState) {
    "use strict";

    var colorScratch = new Color();

    var Batch = function(primitives, translucent, appearanceType, closed) {
        this.translucent = translucent;
        this.appearanceType = appearanceType;
        this.closed = closed;
        this.primitives = primitives;
        this.createPrimitive = false;
        this.primitive = undefined;
        this.geometry = new AssociativeArray();
        this.updaters = new AssociativeArray();
        this.updatersWithAttributes = new AssociativeArray();
        this.attributes = new AssociativeArray();
        this.subscriptions = new AssociativeArray();
        this.toggledObjects = new AssociativeArray();
        this.itemsToRemove = [];
    };

    Batch.prototype.uiShowChanged = function(dynamicObject, propertyName, value, oldValue) {
        if (propertyName === 'uiShow' && value !== oldValue) {
            this.toggledObjects.set(dynamicObject.id, dynamicObject);
        }
    };

    Batch.prototype.add = function(updater, instance) {
        var id = updater.dynamicObject.id;
        this.createPrimitive = true;
        this.geometry.set(id, instance);
        this.updaters.set(id, updater);
        if (!updater.hasConstantFill || !updater.fillMaterialProperty.isConstant) {
            this.updatersWithAttributes.set(id, updater);
        }
        this.subscriptions.set(id, updater.dynamicObject.definitionChanged.addEventListener(Batch.prototype.uiShowChanged, this));
    };

    Batch.prototype.remove = function(updater) {
        var id = updater.dynamicObject.id;
        this.createPrimitive = this.geometry.remove(id) || this.createPrimitive;
        this.updaters.remove(id);
        this.updatersWithAttributes.remove(id);
        this.toggledObjects.removeAll();
        var subscription = this.subscriptions.get(id);
        if (defined(subscription)) {
            subscription();
        }
        this.subscriptions.remove(id);
    };

    Batch.prototype.update = function(time) {
        var removedCount = 0;
        var primitive = this.primitive;
        var primitives = this.primitives;
        if (this.createPrimitive) {
            this.attributes.removeAll();
            if (defined(primitive)) {
                primitives.remove(primitive);
            }
            var geometry = this.geometry.values;
            if (geometry.length > 0) {
                primitive = new Primitive({
                    asynchronous : false,
                    geometryInstances : geometry,
                    appearance : new this.appearanceType({
                        faceForward : true,
                        translucent : this.translucent,
                        closed : this.closed
                    })
                });

                primitives.add(primitive);
            }
            this.primitive = primitive;
            this.createPrimitive = false;
        } else if (defined(primitive) && primitive._state === PrimitiveState.COMPLETE){
            var updater;
            var dynamicObject;
            var id;
            var attributes;
            var i;

            var updatersWithAttributes = this.updatersWithAttributes.values;
            var length = updatersWithAttributes.length;
            for (i = 0; i < length; i++) {
                updater = updatersWithAttributes[i];
                dynamicObject = updater.dynamicObject;
                id = dynamicObject.id;

                attributes = this.attributes.get(id);
                if (!defined(attributes)) {
                    attributes = primitive.getGeometryInstanceAttributes(dynamicObject);
                    this.attributes.set(id, attributes);
                }

                if (!updater.fillMaterialProperty.isConstant) {
                    var colorProperty = updater.fillMaterialProperty.color;
                    colorProperty.getValue(time, colorScratch);
                    attributes.color = ColorGeometryInstanceAttribute.toValue(colorScratch, attributes.color);
                    if ((this.translucent && attributes.color[3] === 255) || (!this.translucent && attributes.color[3] !== 255)) {
                        this.itemsToRemove[removedCount++] = updater;
                    }
                }

                if (!updater.hasConstantFill) {
                    attributes.show = ShowGeometryInstanceAttribute.toValue(updater.isFilled(time), attributes.show);
                }
            }

            var updaters = this.updaters;
            var toggledObjects = this.toggledObjects.values;
            length = toggledObjects.length;
            for (i = 0; i < length; i++) {
                dynamicObject = toggledObjects[i];
                id = dynamicObject.id;
                updater = updaters.get(id);
                attributes = this.attributes.get(id);
                if (!defined(attributes)) {
                    attributes = primitive.getGeometryInstanceAttributes(dynamicObject);
                    this.attributes.set(id, attributes);
                }
                attributes.show = ShowGeometryInstanceAttribute.toValue(updater.isFilled(time) && dynamicObject.uiShow, attributes.show);
            }
            this.toggledObjects.removeAll();
        }
        this.itemsToRemove.length = removedCount;
    };

    Batch.prototype.removeAllPrimitives = function() {
        var primitive = this.primitive;
        if (defined(primitive)) {
            this.primitives.remove(primitive);
            this.primitive = undefined;
        }
        this.geometry.removeAll();
        this.updaters.removeAll();
        this.updatersWithAttributes.removeAll();
        this.attributes.removeAll();
        this.toggledObjects.removeAll();

        var subscriptions = this.subscriptions.values;
        var len = subscriptions.length;
        for (var i = 0; i < len; i++) {
            subscriptions[i]();
        }
        this.subscriptions.removeAll();
        this.itemsToRemove.length = 0;
    };

    /**
     * @private
     */
    var StaticGeometryColorBatch = function(primitives, appearanceType, closed) {
        this._solidBatch = new Batch(primitives, false, appearanceType, closed);
        this._translucentBatch = new Batch(primitives, true, appearanceType, closed);
    };

    StaticGeometryColorBatch.prototype.add = function(time, updater) {
        var instance = updater.createFillGeometryInstance(time);
        if (instance.attributes.color.value[3] === 255) {
            this._solidBatch.add(updater, instance);
        } else {
            this._translucentBatch.add(updater, instance);
        }
    };

    StaticGeometryColorBatch.prototype.remove = function(updater) {
        if (!this._solidBatch.remove(updater)) {
            this._translucentBatch.remove(updater);
        }
    };

    StaticGeometryColorBatch.prototype.update = function(time) {
        var i;
        var updater;

        //Perform initial update
        this._solidBatch.update(time);
        this._translucentBatch.update(time);

        //If any items swapped between solid/translucent, we need to
        //move them between batches
        var itemsToRemove = this._solidBatch.itemsToRemove;
        var solidsToMoveLength = itemsToRemove.length;
        if (solidsToMoveLength > 0) {
            for (i = 0; i < solidsToMoveLength; i++) {
                updater = itemsToRemove[i];
                this._solidBatch.remove(updater);
                this._translucentBatch.add(updater, updater.createFillGeometryInstance(time));
            }
        }

        itemsToRemove = this._translucentBatch.itemsToRemove;
        var translucentToMoveLength = itemsToRemove.length;
        if (translucentToMoveLength > 0) {
            for (i = 0; i < translucentToMoveLength; i++) {
                updater = itemsToRemove[i];
                this._translucentBatch.remove(updater);
                this._solidBatch.add(updater, updater.createFillGeometryInstance(time));
            }
        }

        //If we moved anything around, we need to re-build the primitive
        if (solidsToMoveLength > 0 || translucentToMoveLength > 0) {
            this._solidBatch.update(time);
            this._translucentBatch.update(time);
        }
    };

    StaticGeometryColorBatch.prototype.removeAllPrimitives = function() {
        this._solidBatch.removeAllPrimitives();
        this._translucentBatch.removeAllPrimitives();
    };

    return StaticGeometryColorBatch;
});