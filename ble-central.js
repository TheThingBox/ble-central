module.exports = function(RED) {
    "use strict";
    var noble = require("@abandonware/noble");

    var BLECentral = {
        "devices": {},
        "pendingSubscriptions": {},
        "subscribe": function(subscriberId, uuid, event, callback){
            if(this.devices[uuid]){
                if(!this.devices[uuid].subscriptions){
                    this.devices[uuid].subscriptions = {};
                }
                if(!this.devices[uuid].subscriptions[event]){
                    this.devices[uuid].subscriptions[event] = {};
                }
                this.devices[uuid].subscriptions[event][subscriberId] = callback;
            }else{
                if(!this.pendingSubscriptions[uuid]){
                    this.pendingSubscriptions[uuid] = [];
                }
                this.pendingSubscriptions[uuid].push({
                    "subscriberId": subscriberId,
                    "event": event,
                    "callback": callback
                });
            }
        },
        "unsubscribe": function(subscriberId, uuid, event){
            if(this.devices[uuid] && this.devices[uuid].subscriptions && this.devices[uuid].subscriptions[event] && this.devices[uuid].subscriptions[event][subscriberId]){
                delete this.devices[uuid].subscriptions[event][subscriberId];
            }
        },
        "processAction": function(payload){
            var valToBuffer = function(hexOrIntArray, len=1) {
                if (Buffer.isBuffer(hexOrIntArray)) {
                    return hexOrIntArray;
                }
                if (typeof hexOrIntArray === "number") {
                    let rawHex = parseInt(hexOrIntArray).toString(16);
                    if (rawHex.length < (len * 2)) {
                        rawHex = Array((len * 2) - rawHex.length + 1).join("0") + rawHex;
                    }
                    if (rawHex.length % 2 === 1) {
                        rawHex = "0" + rawHex;
                    }
                    return new Buffer(rawHex, "hex");
                }
                if (typeof hexOrIntArray === "string") {
                    if (hexOrIntArray.length < (len * 2)) {
                        hexOrIntArray = Array((len * 2) - hexOrIntArray.length + 1).join("0") + hexOrIntArray;
                    }
                    if (hexOrIntArray.length % 2 === 1) {
                        hexOrIntArray = "0" + hexOrIntArray;
                    }
                    return new Buffer(hexOrIntArray, "hex");
                }
                if (Array.isArray(hexOrIntArray)) {
                    for (let i = 0; i < len - hexOrIntArray.length; i++) {
                        hexOrIntArray.splice(0, 0, 0);
                    }
                    return new Buffer(hexOrIntArray);
                }
                return new Buffer(0);
            };
            return new Promise( (resolve, reject) => {
                switch(payload.action){
                    case "write":{
                        for(var i = 0 ; i < this.characteristics.length ; i++){
                            if(this.characteristics[i].uuid === payload.characteristic){
                                this.characteristics[i].write(valToBuffer(payload.data), false, (err) => {
                                    if(err){
                                        reject({
                                            "key": "write_failed",
                                            "message": err.message
                                        });
                                    }else{
                                        resolve({});
                                    }
                                });
                                break;
                            }
                        }
                        break;
                    }
                    case "read":{
                        for(var i = 0 ; i < this.characteristics.length ; i++){
                            if(this.characteristics[i].uuid === payload.characteristic){
                                this.characteristics[i].read((err, data) => {
                                    if(err){
                                        reject({
                                            "key": "read_failed",
                                            "message": err.message
                                        });
                                    }else{
                                        resolve({
                                            "value": data
                                        });
                                    }
                                });
                            }
                        }
                        break;
                    }
                    case "listCharacteristics":{
                        var characteristics = [];
                        for(var i = 0 ; i < this.characteristics.length ; i++){
                            var c = this.characteristics[i];
                            characteristics.push({
                                "uuid": c.uuid,
                                "type": (c.type?c.type:"custom"),
                                "name": (c.name?c.name:"Unnamed"),
                                "properties": c.properties
                            });
                        }
                        resolve({
                            "value": characteristics
                        });
                        break;
                    }
                    case "connect":{
                        resolve();
                        break;
                    }
                    default:{
                        reject({
                            "key": "unsupported_action",
                            "message": "Action not supported"
                        });
                        return;
                    }
                }
            });
        },
        "process": function(node, msg){
            if(noble._peripherals[node.uuid]){
                let peripheral = noble._peripherals[node.uuid];

                switch(peripheral.state){
                    case "disconnected":{
                        if (!peripheral._disconnectedHandlerSet) {
                            peripheral._disconnectedHandlerSet = true;
                            peripheral.once("disconnect", () => {
                                if(node.keepConnectionAlive){
                                    node.status({fill:"red",shape:"ring",text:"disconnected"});
                                }
                                peripheral._disconnectedHandlerSet = false;
                            });
                        }
                        if (!peripheral._connectHandlerSet) {
                            peripheral._connectHandlerSet = true;
                            peripheral.once("connect", () => {
                                //Seems like some dongles stopScan during connection process???
                                if(node.keepConnectionAlive){
                                    node.status({fill:"green",shape:"ring",text:"connected"});
                                }
                                startScan();
                                peripheral._connectHandlerSet = false;
                                peripheral.discoverAllServicesAndCharacteristics( (err, services, characteristics) => {
                                    if (err) {
                                        console.log("[" + node.uuid + "] ERROR - " + err.message);
                                        return;
                                    }
                                    node.status({fill:"yellow",shape:"ring",text:"processing..."});
                                    this.characteristics = characteristics || [];
                                    this.processAction(msg.payload).then( (payload) => {
                                        node.status({fill:"green",shape:"ring",text:"success"});
                                        msg.payload = payload;
                                        if(!node.keepConnectionAlive){
                                            peripheral.disconnect();
                                        }
                                        node.send(msg);
                                    }).catch( (err) => {
                                        node.status({fill:"red",shape:"ring",text:"error"});
                                        msg.payload = err;
                                        node.send(msg);
                                    });
                                });
                            });
                            node.status({fill:"yellow",shape:"ring",text:"connecting..."});
                            peripheral.connect();
                        }
                        break;
                    }
                    case "connected":{
                        if(node.keepConnectionAlive){
                            node.status({fill:"green",shape:"ring",text:"connected"});
                        }
                        if (!peripheral._disconnectedHandlerSet) {
                            peripheral._disconnectedHandlerSet = true;
                            peripheral.once("disconnect", () => {
                                if(node.keepConnectionAlive){
                                    node.status({fill:"red",shape:"ring",text:"disconnected"});
                                }
                                peripheral._disconnectedHandlerSet = false;
                            });
                        }
                        node.status({fill:"yellow",shape:"ring",text:"processing..."});
                        if (peripheral.services) {
                            this.characteristics = peripheral.services.reduce((prev, curr) => {
                                return prev.concat(curr.characteristics);
                            }, []) || [];
                        }
                        this.processAction(msg.payload).then( (payload) => {
                            node.status({fill:"green",shape:"ring",text:"success"});
                            msg.payload = payload;
                            if(!node.keepConnectionAlive){
                                peripheral.disconnect();
                            }
                            node.send(msg);
                        }).catch( (err) => {
                            node.status({fill:"red",shape:"ring",text:"error"});
                            msg.payload = err;
                            node.send(msg);
                        });
                        break;
                    }
                    default:{
                        return;
                    }
                }
            }else{
                node.status({fill:"red",shape:"ring",text:"not detected"});
            }
        }
    };

    //Global scope
    function startScan(){
        noble.startScanning([], true);//any UUID, allow duplicates
    }

    noble.on("discover", function(peripheral) {
        var manufacturerData = peripheral.advertisement.manufacturerData;
        var localName = peripheral.advertisement.localName;

        if(!BLECentral.devices[peripheral.uuid]){
            //New device
            var device = {
                "peripheral": peripheral,
                "subscriptions": {}
            };
            BLECentral.devices[peripheral.uuid] = device;
            if(BLECentral.pendingSubscriptions[peripheral.uuid]){
                while(BLECentral.pendingSubscriptions[peripheral.uuid].length > 0){
                    var ps = BLECentral.pendingSubscriptions[peripheral.uuid].shift();
                    BLECentral.subscribe(ps.subscriberId, peripheral.uuid, ps.event, ps.callback);
                }
            }
        } else {
            //Device known, call subscribers
            var device = BLECentral.devices[peripheral.uuid];
            var bleMsg = {
                "payload": device.peripheral.advertisement
            };
            if(device.subscriptions["advertising"]){
                Object.keys(device.subscriptions["advertising"]).forEach((subscriberId) => {
                    device.subscriptions["advertising"][subscriberId](Object.assign({}, bleMsg));
                });
            }
        }
    });

    noble.on("stateChange", function(state) {
        if (state === "poweredOn") {
            startScan();
        } else {
            console.log("Noble state changed for " + state);
        }
    });

    if (noble.state === "poweredOn") {
        startScan();
    }

    RED.httpAdmin.get("/ble-central/devices", RED.auth.needsPermission("ble-central.read"), (req, res) => {
        var devicesList = [];
        Object.keys(noble._peripherals).forEach( (uuid) => {
            let _p = noble._peripherals[uuid];
            devicesList.push({
                "name": _p.advertisement.localName || "Unknown",
                "id": uuid,
                "connectable": _p.connectable
            });
        });
        res.json(devicesList);
    });

    RED.httpAdmin.get("/ble-central/devices/:uuid/characteristics", RED.auth.needsPermission("ble-central.read"), (req, res) => {
        var fakeNode = {
            "status": () => {},
            "send": (msg) => {
                if(msg.payload.hasOwnProperty("key")){
                    //Error
                    res.json({
                        "message": "errror",
                        "value": msg.payload
                    });
                }else{
                    res.json(msg.payload.value);
                }
            },
            "uuid": req.params.uuid,
            "keepConnectionAlive": false
        };

        var fakeMsg = {
            "payload":{
                "action": "listCharacteristics"
            }
        };

        BLECentral.process(fakeNode, fakeMsg);
    });

    function bleCentralAdvertising(n) {
        RED.nodes.createNode(this, n);

        this.uuid = n["ble-peripheral-uuid"];

        if(this.uuid){
            BLECentral.subscribe(this.id, this.uuid, "advertising", (bleMsg) => {
                this.send(bleMsg);
            });
        }

        this.on("close", () => {
            BLECentral.unsubscribe(this.id, this.uuid, "advertising");
        });
    }
    RED.nodes.registerType("ble-central-advertising", bleCentralAdvertising);

    function bleCentralConnection(n) {
        RED.nodes.createNode(this, n);

        this.uuid = n["ble-peripheral-uuid"];
        this.keepConnectionAlive = n["keep-connection"];

        if(this.keepConnectionAlive){
            BLECentral.subscribe(this.id, this.uuid, "advertising", (bleMsg) => {
                BLECentral.unsubscribe(this.id, this.uuid, "advertising");
                BLECentral.process(this, {
                    "payload": {
                        "action": "connect"
                    }
                });
            });
        }

        this.on("input", (msg) => {
            BLECentral.process(this, msg);
        });

        this.on("close", () => {
            BLECentral.unsubscribe(this.id, this.uuid, "advertising");
        });
    }
    RED.nodes.registerType("ble-central-connection", bleCentralConnection);
}
