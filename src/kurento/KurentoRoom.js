// Room --------------------------------
var RpcBuilder = require('kurento-jsonrpc');
var EventEmitter = require('wolfy87-eventemitter');
var kurentoUtils = require('kurento-utils');
var BrowserWebSocket = global.WebSocket || global.MozWebSocket;
var WebSocket = BrowserWebSocket;
if (!WebSocket && typeof window === 'undefined') {
    try {
        WebSocket = require('ws');
    } catch (e) {}
}

function jq(myid) {

    return "#" + myid.replace(/(@|:|\.|\[|\]|,)/g, "\\$1");

}

function Room(kurento, options) {

    var that = this;

    that.name = options.room;

    var ee = new EventEmitter();
    var streams = {};
    var participants = {};
    var connected = false;
    var localParticipant;
    var subscribeToStreams = options.subscribeToStreams || true;

    this.getLocalParticipant = function() {
        return localParticipant;
    }

    this.addEventListener = function(eventName, listener) {
        ee.addListener(eventName, listener);
    }

    this.emitEvent = function(eventName, eventsArray) {
        ee.emitEvent(eventName, eventsArray);
    }

    this.connect = function() {

        kurento.sendRequest('joinRoom', {
            user: options.user,
            room: options.room,
            token: options.token,
            type: options.type
        }, function(error, response) {
            if (error) {
                ee.emitEvent('error-room', [{
                    error: error
                }]);
                //console.error(error);
            } else {

                connected = true;

                var exParticipants = response.value;

                var roomEvent = {
                    participants: [],
                    streams: []
                }

                var length = exParticipants.length;
                for (var i = 0; i < length; i++) {

                    var participant = new Participant(kurento, false, that,
                        exParticipants[i]);

                    participants[participant.getID()] = participant;

                    roomEvent.participants.push(participant);

                    var streams = participant.getStreams();
                    for (var key in streams) {
                        roomEvent.streams.push(streams[key]);
                        if (subscribeToStreams) {
                            streams[key].subscribe();
                        }
                    }
                }

                ee.emitEvent('room-connected', [roomEvent]);
            }
        });
    }


    this.subscribe = function(stream) {
        stream.subscribe();
    }

    this.onParticipantPublished = function(options) {

        var participant = new Participant(kurento, false, that, options);

        var pid = participant.getID();
        if (!(pid in participants)) {
            console.info("Publisher not found in participants list by its id", pid);
        } else {
            console.log("Publisher found in participants list by its id", pid);
        }
        //replacing old participant (this one has streams)
        participants[pid] = participant;

        ee.emitEvent('participant-published', [{
            participant: participant
        }]);

        var streams = participant.getStreams();
        for (var key in streams) {

            var stream = streams[key];

            if (subscribeToStreams) {
                stream.subscribe();
                ee.emitEvent('stream-added', [{
                    stream: stream
                }]);
            }
        }
    }

    this.onParticipantJoined = function(msg) {
        var participant = new Participant(kurento, false, that, msg);
        var pid = participant.getID();
        if (!(pid in participants)) {
            console.log("New participant to participants list with id", pid);
            participants[pid] = participant;
        } else {
            //use existing so that we don't lose streams info
            console.info("Participant already exists in participants list with " +
                "the same id, old:", participants[pid], ", joined now:", participant);
            participant = participants[pid];
        }

        ee.emitEvent('participant-joined', [{
            participant: participant
        }]);
    }

    this.onParticipantLeft = function(msg) {

        var participant = participants[msg.name];

        if (participant !== undefined) {
            delete participants[msg.name];

            ee.emitEvent('participant-left', [{
                participant: participant
            }]);

            var streams = participant.getStreams();
            for (var key in streams) {
                ee.emitEvent('stream-removed', [{
                    stream: streams[key]
                }]);
            }

            participant.dispose();
        } else {
            console.warn("Participant " + msg.name + " unknown. Participants: " + JSON.stringify(participants));
        }
    };

    this.onParticipantEvicted = function(msg) {
        ee.emitEvent('participant-evicted', [{
            localParticipant: localParticipant
        }]);
    };

    this.onNewMessage = function(msg) {
        console.log("New message: " + JSON.stringify(msg));
        var room = msg.room;
        var user = msg.user;
        var message = msg.message;

        if (user !== undefined) {
            ee.emitEvent('newMessage', [{
                room: room,
                user: user,
                message: message
            }]);
        } else {
            console.error("User undefined in new message:", msg);
        }
    }

    this.recvIceCandidate = function(msg) {
        var candidate = {
            candidate: msg.candidate,
            sdpMid: msg.sdpMid,
            sdpMLineIndex: msg.sdpMLineIndex
        }
        var participant = participants[msg.endpointName];
        if (!participant) {
            console.error("Participant not found for endpoint " +
                msg.endpointName + ". Ice candidate will be ignored.",
                candidate);
            return false;
        }
        var streams = participant.getStreams();
        for (var key in streams) {
            var stream = streams[key];
            stream.getWebRtcPeer().addIceCandidate(candidate, function(error) {
                if (error) {
                    console.error("Error adding candidate for " + key + " stream of endpoint " + msg.endpointName + ": " + error);
                    return;
                }
            });
        }
    }

    this.onRoomClosed = function(msg) {
        console.log("Room closed: " + JSON.stringify(msg));
        var room = msg.room;
        if (room !== undefined) {
            ee.emitEvent('room-closed', [{
                room: room
            }]);
        } else {
            console.error("Room undefined in on room closed", msg);
        }
    }

    this.onMediaError = function(params) {
        console.error("Media error: " + JSON.stringify(params));
        var error = params.error;
        if (error) {
            ee.emitEvent('error-media', [{
                error: error
            }]);
        } else {
            console.error("Received undefined media error. Params:", params);
        }
    }

    this.leave = function(forced) {
        forced = !!forced;
        console.log("Leaving room (forced=" + forced + ")");
        if (connected && !forced) {
            kurento.sendRequest('leaveRoom', function(error, response) {
                if (error) {
                    console.error(error);
                } else {
                    connected = false;
                }
            });
        }

        for (var key in participants) {
            participants[key].dispose();
        }
    }

    this.disconnect = function(stream) {
        var participant = stream.getParticipant();
        if (!participant) {
            console.error("Stream to disconnect has no participant", stream);
            return false;
        }

        delete participants[participant.getID()];
        participant.dispose();

        if (participant === localParticipant) {
            console.log("Unpublishing my media (I'm " + participant.getID() + ")");
            delete localParticipant;
            kurento.sendRequest('unpublishVideo', function(error, response) {
                if (error) {
                    console.error(error);
                } else {
                    console.info("Media unpublished correctly");
                }
            });
        } else {
            console.log("Unsubscribing from " + stream.getGlobalID());
            kurento.sendRequest('unsubscribeFromVideo', {
                    sender: stream.getGlobalID()
                },
                function(error, response) {
                    if (error) {
                        console.error(error);
                    } else {
                        console.info("Unsubscribed correctly from " + stream.getGlobalID());
                    }
                });
        }
    }

    this.getStreams = function() {
        return streams;
    }

    localParticipant = new Participant(kurento, true, that, { id: options.user });
    participants[options.user] = localParticipant;
}

// Participant --------------------------------

function Participant(kurento, local, room, options) {

    var that = this;
    var id = options.id;

    var streams = {};
    var streamsOpts = [];

    if (options.streams) {
        for (var i = 0; i < options.streams.length; i++) {
            var streamOpts = {
                id: options.streams[i].id,
                participant: that,
                recvVideo: (options.streams[i].recvVideo == undefined ? true : options.streams[i].recvVideo),
                recvAudio: (options.streams[i].recvAudio == undefined ? true : options.streams[i].recvAudio)
            }
            var stream = new Stream(kurento, false, room, streamOpts);
            addStream(stream);
            streamsOpts.push(streamOpts);
        }
    }
    console.log("New " + (local ? "local " : "remote ") + "participant " + id + ", streams opts: ", streamsOpts);

    that.setId = function(newId) {
        id = newId;
    }

    function addStream(stream) {
        streams[stream.getID()] = stream;
        room.getStreams()[stream.getID()] = stream;
    }

    that.addStream = addStream;

    that.getStreams = function() {
        return streams;
    }

    that.dispose = function() {
        for (var key in streams) {
            streams[key].dispose();
        }
    }

    that.getID = function() {
        return id;
    }

    this.sendIceCandidate = function(candidate) {
        console.debug((local ? "Local" : "Remote"), "candidate for",
            that.getID(), JSON.stringify(candidate));
        kurento.sendRequest("onIceCandidate", {
            endpointName: that.getID(),
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex
        }, function(error, response) {
            if (error) {
                console.error("Error sending ICE candidate: " + JSON.stringify(error));
            }
        });
    }
}

// Stream --------------------------------

/*
 * options: name: XXX data: true (Maybe this is based on webrtc) audio: true,
 * video: true, url: "file:///..." > Player screen: true > Desktop (implicit
 * video:true, audio:false) audio: true, video: true > Webcam
 *
 * stream.hasAudio(); stream.hasVideo(); stream.hasData();
 */
function Stream(kurento, local, room, options) {

    var that = this;

    that.room = room;

    var ee = new EventEmitter();
    var sdpOffer;
    var wrStream;
    var wp;
    var id;
    if (options.id) {
        id = options.id;
    } else {
        id = "webcam";
    }
    var video;

    var videoElements = [];
    var elements = [];
    var participant = options.participant;

    var recvVideo = options.recvVideo;
    this.getRecvVideo = function() {
        return recvVideo;
    }

    var recvAudio = options.recvAudio;
    this.getRecvAudio = function() {
        return recvAudio;
    }

    var showMyRemote = false;
    this.subscribeToMyRemote = function() {
        showMyRemote = true;
    }
    this.displayMyRemote = function() {
        return showMyRemote;
    }

    var localMirrored = false;
    this.mirrorLocalStream = function(wr) {
        showMyRemote = true;
        localMirrored = true;
        if (wr)
            wrStream = wr;
    }
    this.isLocalMirrored = function() {
        return localMirrored;
    }

    this.getWrStream = function() {
        return wrStream;
    }

    this.getWebRtcPeer = function() {
        return wp;
    }

    this.addEventListener = function(eventName, listener) {
        ee.addListener(eventName, listener);
    }

    function showSpinner(spinnerParentId) {
        var progress = document.createElement('div');
        progress.id = 'progress-' + that.getGlobalID();
        progress.style.background = "center transparent url('img/spinner.gif') no-repeat";
        document.getElementById(spinnerParentId).appendChild(progress);
    }

    function hideSpinner(spinnerId) {
        spinnerId = (typeof spinnerId === 'undefined') ? that.getGlobalID() : spinnerId;
        $(jq('progress-' + spinnerId)).hide();
    }

    this.playOnlyVideo = function(parentElement, thumbnailId) {
        video = document.createElement('video');

        video.id = 'native-video-' + that.getGlobalID();
        video.autoplay = true;
        video.controls = false;
        if (wrStream) {
            video.src = URL.createObjectURL(wrStream);
            $(jq(thumbnailId)).show();
            hideSpinner();
        } else
            console.log("No wrStream yet for", that.getGlobalID());

        videoElements.push({
            thumb: thumbnailId,
            video: video
        });

        if (local) {
            video.muted = true;
        }

        if (typeof parentElement === "string") {
            document.getElementById(parentElement).appendChild(video);
        } else {
            parentElement.appendChild(video);
        }
    }

    this.playThumbnail = function(thumbnailId) {

        var container = document.createElement('div');
        container.className = "participant";
        container.id = that.getGlobalID();
        document.getElementById(thumbnailId).appendChild(container);

        elements.push(container);

        var name = document.createElement('div');
        container.appendChild(name);
        name.appendChild(document.createTextNode(that.getGlobalID()));
        name.id = "name-" + that.getGlobalID();
        name.className = "name";

        showSpinner(thumbnailId);

        that.playOnlyVideo(container, thumbnailId);
    }

    this.getID = function() {
        return id;
    }

    this.getParticipant = function() {
        return participant;
    }

    this.getGlobalID = function() {
        if (participant) {
            return participant.getID() + "_" + id;
        } else {
            return id + "_webcam";
        }
    }

    this.init = function() {
        participant.addStream(that);
        var constraints = {
            audio: true,
            video: {
                mandatory: {
                    maxWidth: 640
                },
                optional: [
                    { maxFrameRate: 15 },
                    { minFrameRate: 15 }
                ]
            }
        };

        navigator.getUserMedia(constraints, function(userStream) {
            wrStream = userStream;
            ee.emitEvent('access-accepted', null);
        }, function(error) {
            console.error("Access denied", error);
            ee.emitEvent('access-denied', null);
        });
    }

    this.publishVideoCallback = function(error, sdpOfferParam, wp) {
        if (error) {
            return console.error("(publish) SDP offer error: " + JSON.stringify(error));
        }
        console.log("Sending SDP offer to publish as " + that.getGlobalID(), sdpOfferParam);
        kurento.sendRequest("publishVideo", {
            sdpOffer: sdpOfferParam,
            doLoopback: that.displayMyRemote() || false
        }, function(error, response) {
            if (error) {
                console.error("Error on publishVideo: " + JSON.stringify(error));
            } else {
                that.room.emitEvent('stream-published', [{
                    stream: that
                }])
                that.processSdpAnswer(response.sdpAnswer);
            }
        });
    }

    this.startVideoCallback = function(error, sdpOfferParam, wp) {
        if (error) {
            return console.error("(subscribe) SDP offer error: " + JSON.stringify(error));
        }
        console.log("Sending SDP offer to subscribe to " + that.getGlobalID(), sdpOfferParam);
        kurento.sendRequest("receiveVideoFrom", {
            sender: that.getGlobalID(),
            sdpOffer: sdpOfferParam
        }, function(error, response) {
            if (error) {
                console.error("Error on recvVideoFrom: " + JSON.stringify(error));
            } else {
                that.processSdpAnswer(response.sdpAnswer);
            }
        });
    }

    function initWebRtcPeer(sdpOfferCallback) {
        if (local) {
            var options = {
                videoStream: wrStream,
                onicecandidate: participant.sendIceCandidate.bind(participant)
            }
            if (that.displayMyRemote()) {
                wp = new kurentoUtils.WebRtcPeer.WebRtcPeerSendrecv(options, function(error) {
                    if (error) {
                        return console.error(error);
                    }
                    this.generateOffer(sdpOfferCallback.bind(that));
                });
            } else {
                wp = new kurentoUtils.WebRtcPeer.WebRtcPeerSendonly(options, function(error) {
                    if (error) {
                        return console.error(error);
                    }
                    this.generateOffer(sdpOfferCallback.bind(that));
                });
            }
        } else {
            var offerConstraints = {
                mandatory: {
                    OfferToReceiveVideo: recvVideo,
                    OfferToReceiveAudio: recvAudio
                }
            };
            console.log("Constraints of generate SDP offer (subscribing)",
                offerConstraints);
            var options = {
                onicecandidate: participant.sendIceCandidate.bind(participant),
                connectionConstraints: offerConstraints
            }
            wp = new kurentoUtils.WebRtcPeer.WebRtcPeerRecvonly(options, function(error) {
                if (error) {
                    return console.error(error);
                }
                this.generateOffer(sdpOfferCallback.bind(that));
            });
        }
        console.log("Waiting for SDP offer to be generated (" + (local ? "local" : "remote") + " peer: " + that.getGlobalID() + ")");
    }

    this.publish = function() {

        // FIXME: Throw error when stream is not local

        initWebRtcPeer(that.publishVideoCallback);

        // FIXME: Now we have coupled connecting to a room and adding a
        // stream to this room. But in the new API, there are two steps.
        // This is the second step. For now, it do nothing.

    }

    this.subscribe = function() {

        // FIXME: In the current implementation all participants are subscribed
        // automatically to all other participants. We use this method only to
        // negotiate SDP

        initWebRtcPeer(that.startVideoCallback);
    }

    this.processSdpAnswer = function(sdpAnswer) {
        var answer = new RTCSessionDescription({
            type: 'answer',
            sdp: sdpAnswer,
        });
        console.log(that.getGlobalID() + ": set peer connection with recvd SDP answer",
            sdpAnswer);
        var pc = wp.peerConnection;
        pc.setRemoteDescription(answer, function() {
            // Avoids to subscribe to your own stream remotely 
            // except when showMyRemote is true
            if (!local || that.displayMyRemote()) {
                wrStream = pc.getRemoteStreams()[0];
                ee.emitEvent('stream-recive', [{ id: id, stream: wrStream }]);
                console.log("Peer remote stream", wrStream);
                for (i = 0; i < videoElements.length; i++) {
                    var thumbnailId = videoElements[i].thumb;
                    var video = videoElements[i].video;
                    video.src = URL.createObjectURL(wrStream);
                    video.onplay = function() {
                        //is ('native-video-' + that.getGlobalID())
                        var elementId = this.id;
                        var videoId = elementId.split("-");
                        $(jq(thumbnailId)).show();
                        hideSpinner(videoId[2]);
                    };
                }
                that.room.emitEvent('stream-subscribed', [{
                    stream: that
                }]);
            }
        }, function(error) {
            console.error(that.getGlobalID() + ": Error setting SDP to the peer connection: " + JSON.stringify(error));
        });
    }

    this.unpublish = function() {
        if (wp) {
            wp.dispose();
        } else {
            if (wrStream) {
                wrStream.getAudioTracks().forEach(function(track) {
                    track.stop && track.stop()
                })
                wrStream.getVideoTracks().forEach(function(track) {
                    track.stop && track.stop()
                })
            }
        }

        console.log(that.getGlobalID() + ": Stream '" + id + "' unpublished");
    }

    this.dispose = function() {

        function disposeElement(element) {
            if (element && element.parentNode) {
                element.parentNode.removeChild(element);
            }
        }

        for (i = 0; i < elements.length; i++) {
            disposeElement(elements[i]);
        }

        for (i = 0; i < videoElements.length; i++) {
            disposeElement(videoElements[i].video);
        }

        if (wp) {
            wp.dispose();
        } else {
            if (wrStream) {
                wrStream.getAudioTracks().forEach(function(track) {
                    track.stop && track.stop()
                })
                wrStream.getVideoTracks().forEach(function(track) {
                    track.stop && track.stop()
                })
            }
        }

        console.log(that.getGlobalID() + ": Stream '" + id + "' disposed");
    }
}

// KurentoRoom --------------------------------

function KurentoRoom(wsUri, callback) {
    if (!(this instanceof KurentoRoom))
        return new KurentoRoom(wsUri, callback);

    var RECONNECTING = 'RECONNECTING';
    var CONNECTED = 'CONNECTED';
    var DISCONNECTED = 'DISCONNECTED';

    var RECONNECTING = "RECONNECTING";
    var CONNECTED = "CONNECTED";
    var DISCONNECTED = "DISCONNECTED";

    var that = this;

    var userName;

    var notReconnectIfNumLessThan = -1;

    var heartbeat = 60000;
    var pingNextNum = 0;
    var enabledPings = true;
    var pingPongStarted = false;
    var pingInterval;
    var status = DISCONNECTED;


    var ws = new WebSocket(wsUri);

    ws.onopen = function() {
        callback(null, that);
        onconnected();
    }

    ws.onerror = function(evt) {
        callback(evt.data);
        onconnected();
    }

    ws.onclose = function() {
        console.log("Connection Closed");
        if (pingInterval != undefined) {
            clearInterval(pingInterval);
        }
        pingPongStarted = false;
        enabledPings = false;
        that.close();
    }

    var onconnected = function() {
        console.log("--------- ONCONNECTED -----------");
        if (status === CONNECTED) {
            console.log("Websocket already in CONNECTED state when receiving a new ONCONNECTED message. Ignoring it");
            return;
        }
        status = CONNECTED;

        enabledPings = true;
        usePing();

        if (onconnected) {
            onconnected();
        }
    }

    /*
     * If configuration.hearbeat has any value, the ping-pong will work with the interval
     * of configuration.hearbeat
     */
    function usePing() {
        if (!pingPongStarted) {
            console.log("Starting ping (if configured)")
            pingPongStarted = true;

            if (heartbeat != undefined) {
                pingInterval = setInterval(sendPing, heartbeat);
                sendPing();
            }
        }
    }

    function sendPing() {
        if (enabledPings) {
            var params = null;

            if (pingNextNum == 0 || pingNextNum == notReconnectIfNumLessThan) {
                params = {
                    interval: heartbeat
                };
            }

            pingNextNum++;

            that.sendRequest('ping', params, function(error, result) {
                if (error) {
                    if (pingNextNum > notReconnectIfNumLessThan) {
                        enabledPings = false;
                        // updateNotReconnectIfLessThan();
                        console.log("DSS did not respond to ping message " + pingNextNum + ". Reconnecting... ");
                        //ws.reconnectWs();
                    };
                };
                if (result != undefined && result.message !== 'pong') {
                    console.log('Response: ' + JSON.stringify(result));
                }
            });
        } else {
            console.log("Trying to send ping, but ping is not enabled");
        }
    }


    var options = {
        request_timeout: 50000
    };
    var rpc = new RpcBuilder(RpcBuilder.packers.JsonRPC, options, ws, function(
        request) {
        console.info('Received request: ' + JSON.stringify(request));

        switch (request.method) {
            case 'participantJoined':
                onParticipantJoined(request.params);
                break;
            case 'participantPublished':
                onParticipantPublished(request.params);
                break;
            case 'participantUnpublished':
                //TODO use a different method, don't delete 
                // the participant for future reconnection?
                onParticipantLeft(request.params);
                break;
            case 'participantLeft':
                onParticipantLeft(request.params);
                break;
            case 'participantEvicted':
                onParticipantEvicted(request.params);
                break;
            case 'sendMessage': //CHAT
                onNewMessage(request.params);
                break;
            case 'iceCandidate':
                iceCandidateEvent(request.params);
                break;
            case 'roomClosed':
                onRoomClosed(request.params);
                break;
            case 'mediaError':
                onMediaError(request.params);
                break;
            default:
                console.error('Unrecognized request: ' + JSON.stringify(request));
        };
    });

    function onParticipantJoined(msg) {
        if (room !== undefined) {
            room.onParticipantJoined(msg);
        }
    }

    function onParticipantPublished(msg) {
        if (room !== undefined) {
            room.onParticipantPublished(msg);
        }
    }

    function onParticipantLeft(msg) {
        if (room !== undefined) {
            room.onParticipantLeft(msg);
        }
    }

    function onParticipantEvicted(msg) {
        if (room !== undefined) {
            room.onParticipantEvicted(msg);
        }
    }

    function onNewMessage(msg) {
        if (room !== undefined) {
            room.onNewMessage(msg);
        }
    }

    function iceCandidateEvent(msg) {
        if (room !== undefined) {
            room.recvIceCandidate(msg);
        }
    }

    function onRoomClosed(msg) {
        if (room !== undefined) {
            room.onRoomClosed(msg);
        }
    }

    function onMediaError(params) {
        if (room !== undefined) {
            room.onMediaError(params);
        }
    }

    var rpcParams;

    this.setRpcParams = function(params) {
        rpcParams = params;
    }

    this.sendRequest = function(method, params, callback) {
        if (rpcParams && rpcParams !== "null" && rpcParams !== "undefined") {
            for (var index in rpcParams) {
                if (rpcParams.hasOwnProperty(index)) {
                    params[index] = rpcParams[index];
                }
            }
        }
        rpc.encode(method, params, callback);
        console.log('Sent request: { method:"' + method + '", params: ' + JSON.stringify(params) + ' }');
    };

    this.close = function(forced) {
        if (room !== undefined) {
            room.leave(forced);
        }
        ws.close();
    };

    this.disconnectParticipant = function(stream) {
        if (room !== undefined) {
            room.disconnect(stream);
        }
    }

    this.Stream = function(room, options) {
        options.participant = room.getLocalParticipant();
        return new Stream(that, true, room, options);
    };

    this.Room = function(options) {
        // FIXME Support more than one room
        room = new Room(that, options);
        // FIXME Include name in stream, not in room
        userName = options.userName;
        return room;
    };

    //CHAT
    this.sendMessage = function(room, user, message) {

        this.sendRequest('sendMessage', { message: message, userMessage: user, roomMessage: room }, function(error, response) {
            if (error) {
                console.error(error);
            } else {
                connected = false;
            }
        });
    };

    this.sendCustomRequest = function(params, callback) {
        this.sendRequest('customRequest', params, callback);
    };

}

module.exports.KurentoRoom = KurentoRoom;
module.exports.Room = Room;
module.exports.Participant = Participant;
module.exports.KurentoStream = Stream;