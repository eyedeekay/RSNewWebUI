let m = require('mithril');
let rs = require('rswebui');

function loadLobbyDetails(id, apply) {
  rs.rsJsonApiRequest('/rsMsgs/getChatLobbyInfo', {
      id,
    },
    detail => {
        if (detail.retval) {
            apply(detail.info);
        }
    },
    true, {},
    undefined,
    // Custom serializer NOTE:
    // Since id represents 64-bit int(see deserializer note below)
    // Instead of using JSON.stringify, this function directly
    // creates a json string manually.
    () => '{"id":' + id + '}')
 }

let ChatRoomsModel = {
  allRooms: [],
  subscribedRooms: {},
  loadPublicRooms() {
    // TODO: this doesn't preserve id of rooms,
    // use regex on response to extract ids.
    rs.rsJsonApiRequest('/rsMsgs/getListOfNearbyChatLobbies', {},
      data => {
        ChatRoomsModel.allRooms = data.public_lobbies;
      },
    );
  },
  loadSubscribedRooms() {
    ChatRoomsModel.subscribedRooms = {};
    rs.rsJsonApiRequest('/rsMsgs/getChatLobbyList', {},
      data => data.map(id => loadLobbyDetails(id, info => ChatRoomsModel.subscribedRooms[id] = info)),
      true, {},
      // Custom deserializer NOTE:
      // JS uses double precision numbers of 64 bit. It is equivalent
      // to 53 bits of precision. All large precision ints will
      // get truncated to an approximation.
      // This API uses Cpp-style 64 bits for `id`.
      // Instead of parsing using JSON.parse, this funciton manually
      // extracts all numbers and stores them as strings
      // Note the g flag. The match will return an array of strings
      (response) => response.match(/\d+/g),
    )
  },
  subscribed(info) {
    return this.subscribedRooms.hasOwnProperty(info.lobby_id.xstr64);
  },
};

function printMessage(msg){
  let datetime = new Date(msg.sendTime * 1000).toLocaleString();
  let username = rs.userList.username(msg.lobby_peer_gxs_id);
  let text = msg.msg.replaceAll('<br/>','\n').replace(new RegExp('<style[^<]*</style>|<[^>]*>','gm'),'');
  console.info(text);
  return m('.message', m('span.datetime', datetime), m('span.username', username), m('span.messagetext', text));
}

const ChatLobbyModel = {
    currentLobby: {
        lobby_name: '...',
    },
    messages: [],
    users: [],
    chatId(action) {
        return {type:3,lobby_id:{xstr64:m.route.param('lobby')}};
    },
    loadLobby () {
        loadLobbyDetails(m.route.param('lobby'), detail => {
            this.currentLobby = detail;
            let lobbyid = m.route.param('lobby');
            // apply existing messages to current lobby view
            rs.events[15].chatMessages(this.chatId(),rs.events[15], l => (this.messages = l.map(printMessage)));
            // register for chatEvents for future messages
            rs.events[15].notify = chatMessage => {
                if (chatMessage.chat_id.type===3 && chatMessage.chat_id.lobby_id.xstr64 === lobbyid) {
                    this.messages.push(printMessage(chatMessage));
                    m.redraw();
                }
            }
            // lookup for chat-user names (only snapshot, we don't get notified about changes of participants)
            var names = detail.gxs_ids.reduce((a,u) => a.concat(rs.userList.username(u.key)), []);
            names.sort((a,b) => a.localeCompare(b));
            this.users = [];
            names.forEach(name =>  this.users = this.users.concat([m('.user',name)]));
            return this.users;
        });
    },
    sendMessage(msg, onsuccess) {
        rs.rsJsonApiRequest('/rsmsgs/sendChat', {},
            () => {
              // adding own message to log
              rs.events[15].handler({
                mChatMessage:{
                    chat_id:this.chatId(),
                    msg:msg,
                    sendTime:new Date().getTime()/1000,
                    lobby_peer_gxs_id:this.currentLobby.gxs_id,
                }
              },rs.events[15]);
              onsuccess();
            },
            true, {}, undefined,
            () => '{"id":{"type": 3,"lobby_id":' + m.route.param('lobby') + '}, "msg":' + JSON.stringify(msg) + '}'
        );
    },
}

const Lobby = () => {
  let info = {};
  return {
    oninit: (v) => info = v.attrs.info,
    view: (v) => m( '.lobby.' + (ChatRoomsModel.subscribed(v.attrs.info) ? 'subscribed':'public'), {
      key: v.attrs.info.lobby_id.xstr64,
      onclick: e => {
        if (ChatRoomsModel.subscribed(v.attrs.info)) {
          m.route.set('/chat/:lobby', {
            lobby: v.attrs.info.lobby_id.xstr64
          });
        }
      },
    }, [
      m('h5', info.lobby_name === '' ? '<unnamed>' : info.lobby_name),
      m('p', info.lobby_topic),
    ]),
  };
};

const SubscribedLobbies = () => {
  lobbies = [];
  return {
    oninit: (v) => ChatRoomsModel.loadSubscribedRooms(),
    view: () => m('.widget', [
      m('h3', 'Subscribed chat rooms'),
      m('hr'),
      Object.values(ChatRoomsModel.subscribedRooms).map(info => m(Lobby, {
        info
      })),
    ]),
  };
};

const PublicLobbies = () => {
  return {
    oninit: () => ChatRoomsModel.loadPublicRooms(),
    view: () => m('.widget', [
      m('h3', 'Public chat rooms'),
      m('hr'),
      ChatRoomsModel.allRooms.filter(info => !ChatRoomsModel.subscribed(info)).map(info => m(Lobby, {
            info,
      })),
    ])
  };
};

const Layout = () => {
  return {
    view: vnode => m('.tab-page', [
      m(SubscribedLobbies),
      m(PublicLobbies),
    ]),
  };
};

const LayoutSingle = () => {
  return {
    oninit: ChatLobbyModel.loadLobby(),
    view: vnode => m('.tab-page', [
      m('h3.lobbyName', ChatLobbyModel.currentLobby.lobby_name),
      m('.messages', ChatLobbyModel.messages),
      m('.rightbar', ChatLobbyModel.users),
      m('.chatMessage', {},  m("textarea.chatMsg", {
          placeholder: 'enter new message and press return to send',
          onkeydown: e => {
            if (e.code==='Enter') {
                var msg = e.target.value;
                e.target.value = ' sending ... ';
                ChatLobbyModel.sendMessage(msg, () => e.target.value='');
                return false;
            }
          }
        })
      ),
    ]),
  };
};

module.exports = {
  view: (vnode) => {
    if (m.route.param('lobby') === undefined) {
      return m(Layout);
    } else {
       return m(LayoutSingle);
    }
  }
};

