/* @flow strict-local */
import Immutable from 'immutable';
import invariant from 'invariant';

import type { Narrow, UserId } from '../types';
import { userIdsOfPmNarrow } from '../utils/narrow';
import { pmUnreadsKeyFromPmKeyIds } from '../utils/recipient';
import type { PerAccountApplicableAction } from '../actionTypes';
import type {
  UnreadState,
  UnreadStreamsState,
  UnreadPmsState,
  UnreadHuddlesState,
  UnreadMentionsState,
} from './unreadModelTypes';
import type { PerAccountState } from '../reduxTypes';
import unreadPmsReducer from './unreadPmsReducer';
import unreadHuddlesReducer from './unreadHuddlesReducer';
import unreadMentionsReducer from './unreadMentionsReducer';
import {
  ACCOUNT_SWITCH,
  EVENT_MESSAGE_DELETE,
  EVENT_NEW_MESSAGE,
  EVENT_UPDATE_MESSAGE,
  EVENT_UPDATE_MESSAGE_FLAGS,
  LOGOUT,
  MESSAGE_FETCH_COMPLETE,
  REGISTER_COMPLETE,
} from '../actionConstants';
import * as logging from '../utils/logging';

//
//
// Selectors.
//
// These take the global state as their input.
//

/** The unread-messages state as a whole. */
export const getUnread = (state: PerAccountState): UnreadState => state.unread;

export const getUnreadStreams = (state: PerAccountState): UnreadStreamsState =>
  state.unread.streams;

export const getUnreadPms = (state: PerAccountState): UnreadPmsState => state.unread.pms;

export const getUnreadHuddles = (state: PerAccountState): UnreadHuddlesState =>
  state.unread.huddles;

export const getUnreadMentions = (state: PerAccountState): UnreadMentionsState =>
  state.unread.mentions;

//
//
// Getters.
//
// These operate directly on this particular model's state, as part of this
// model's own interface.
//

/** The total number of unreads in the given topic. */
export const getUnreadCountForTopic = (
  unread: UnreadState,
  streamId: number,
  topic: string,
): number => unread.streams.get(streamId)?.get(topic)?.size ?? 0;

/** All the unread message IDs for a given PM narrow. */
export const getUnreadIdsForPmNarrow = (
  unread: UnreadState,
  narrow: Narrow,
  ownUserId: UserId,
): $ReadOnlyArray<number> => {
  const userIds = userIdsOfPmNarrow(narrow);

  if (userIds.length > 1) {
    const unreadsKey = pmUnreadsKeyFromPmKeyIds(userIds, ownUserId);
    const unreadItem = unread.huddles.find(x => x.user_ids_string === unreadsKey);
    return unreadItem?.unread_message_ids ?? [];
  } else {
    const senderId = userIds[0];
    const unreadItem = unread.pms.find(x => x.sender_id === senderId);
    return unreadItem?.unread_message_ids ?? [];
  }
};

//
//
// Reducer.
//

const initialStreamsState: UnreadStreamsState = Immutable.Map();

// Like `Immutable.Map#map`, but with the update-only-if-different semantics
// of `Immutable.Map#update`.  Kept for comparison to `updateAllAndPrune`.
/* eslint-disable-next-line no-unused-vars */
function updateAll<K, V>(map: Immutable.Map<K, V>, updater: V => V): Immutable.Map<K, V> {
  return map.withMutations(mapMut => {
    map.forEach((value, key) => {
      const newValue = updater(value);
      if (newValue !== value) {
        mapMut.set(key, newValue);
      }
    });
  });
}

// Like `updateAll`, but prune values equal to `zero` given by `updater`.
function updateAllAndPrune<K, V>(
  map: Immutable.Map<K, V>,
  zero: V,
  updater: V => V,
): Immutable.Map<K, V> {
  return map.withMutations(mapMut => {
    map.forEach((value, key) => {
      const newValue = updater(value);
      if (newValue === zero) {
        mapMut.delete(key);
        return;
      }
      if (newValue === value) {
        return; // i.e., continue
      }
      mapMut.set(key, newValue);
    });
  });
}

function deleteMessages(
  state: UnreadStreamsState,
  ids: $ReadOnlyArray<number>,
): UnreadStreamsState {
  const idSet = new Set(ids);
  const toDelete = id => idSet.has(id);
  const emptyList = Immutable.List();
  return updateAllAndPrune(state, Immutable.Map(), perStream =>
    updateAllAndPrune(perStream, emptyList, perTopic =>
      perTopic.find(toDelete) ? perTopic.filterNot(toDelete) : perTopic,
    ),
  );
}

function streamsReducer(
  state: UnreadStreamsState = initialStreamsState,
  action: PerAccountApplicableAction,
  globalState: PerAccountState,
): UnreadStreamsState {
  switch (action.type) {
    case LOGOUT:
    case ACCOUNT_SWITCH:
      // TODO(#4446) also LOGIN_SUCCESS, presumably
      return initialStreamsState;

    case REGISTER_COMPLETE: {
      // This may indeed be unnecessary, but it's legacy; have not investigated
      // if it's this bit of our API types that is too optimistic.
      // flowlint-next-line unnecessary-optional-chain:off
      const data = action.data.unread_msgs?.streams ?? [];

      // First, collect together all the data for a given stream, just in a
      // plain old Array.
      const byStream = new Map();
      for (const { stream_id, topic, unread_message_ids } of data) {
        let perStream = byStream.get(stream_id);
        if (!perStream) {
          perStream = [];
          byStream.set(stream_id, perStream);
        }
        // unread_message_ids is already sorted; see comment at its
        // definition in src/api/initialDataTypes.js.
        perStream.push([topic, Immutable.List(unread_message_ids)]);
      }

      // Then, for each of those plain Arrays build an Immutable.Map from it
      // all in one shot.  This is quite a bit faster than building the Maps
      // incrementally.  For a user with lots of unreads in a busy org, we
      // can be handling 50k message IDs here, across perhaps 2-5k threads
      // in dozens of streams, so the effect is significant.
      return Immutable.Map(Immutable.Seq.Keyed(byStream.entries()).map(Immutable.Map));
    }

    case MESSAGE_FETCH_COMPLETE:
      // TODO handle MESSAGE_FETCH_COMPLETE here.  This rarely matters, but
      //   could in principle: we could be fetching some messages from
      //   before the (long) window included in the initial unreads data.
      //   For comparison, the webapp does handle this case; see the call to
      //   message_util.do_unread_count_updates in message_fetch.js.
      return state;

    case EVENT_NEW_MESSAGE: {
      const { message } = action;
      if (message.type !== 'stream') {
        return state;
      }

      invariant(message.flags, 'message in EVENT_NEW_MESSAGE must have flags');
      if (message.flags.includes('read')) {
        return state;
      }

      // prettier-ignore
      return state.updateIn([message.stream_id, message.subject],
        (perTopic = Immutable.List()) => perTopic.push(message.id));
    }

    case EVENT_MESSAGE_DELETE:
      // TODO optimize by looking up directly; see #4684
      return deleteMessages(state, action.messageIds);

    case EVENT_UPDATE_MESSAGE_FLAGS: {
      if (action.flag !== 'read') {
        return state;
      }

      if (action.all) {
        return initialStreamsState;
      }

      if (action.op === 'remove') {
        // Zulip doesn't support un-reading a message.  Ignore it.
        return state;
      }

      // TODO optimize by looking up directly; see #4684.
      //   Then when do, also optimize so deleting the oldest items is fast,
      //   as that should be the common case here.
      return deleteMessages(state, action.messages);
    }

    case EVENT_UPDATE_MESSAGE: {
      // The API uses "new" for the stream IDs and "orig" for the topics.
      // Put them both in a consistent naming convention.
      const origStreamId = action.stream_id;
      if (origStreamId == null) {
        // Not stream messages, or else a pure content edit (no stream/topic change.)
        // TODO(server-5.0): Simplify comment: since FL 112 this means it's
        //   just not a stream message.
        return state;
      }
      const newStreamId = action.new_stream_id ?? origStreamId;
      const origTopic = action.orig_subject;
      const newTopic = action.subject ?? origTopic;

      if (newTopic === origTopic && newStreamId === origStreamId) {
        // Stream and topic didn't change.
        return state;
      }

      if (origTopic == null) {
        // `orig_subject` is documented to be present when either the
        // stream or topic changed.
        logging.warn('Got update_message event with stream/topic change and no orig_subject');
        return state;
      }
      invariant(newTopic != null, 'newTopic must be non-nullish when origTopic is, by `??`');

      const actionIds = new Set(action.message_ids);
      const matchingIds = state
        .getIn([origStreamId, origTopic], Immutable.List())
        .filter(id => actionIds.has(id));
      if (matchingIds.size === 0) {
        // None of the updated messages were unread.
        return state;
      }

      return state
        .updateIn([origStreamId, origTopic], (messages = Immutable.List()) =>
          messages.filter(id => !actionIds.has(id)),
        )
        .updateIn([newStreamId, newTopic], (messages = Immutable.List()) =>
          messages.push(...matchingIds).sort(),
        );
    }

    default:
      return state;
  }
}

export const reducer = (
  state: void | UnreadState,
  action: PerAccountApplicableAction,
  globalState: PerAccountState,
): UnreadState => {
  const nextState = {
    streams: streamsReducer(state?.streams, action, globalState),

    // Note for converting these other sub-reducers to the new design:
    // Probably first push this four-part data structure down through the
    // `switch` statement, and the other logic that's duplicated between them.
    pms: unreadPmsReducer(state?.pms, action),
    huddles: unreadHuddlesReducer(state?.huddles, action),
    mentions: unreadMentionsReducer(state?.mentions, action),
  };

  if (state && Object.keys(nextState).every(key => nextState[key] === state[key])) {
    return state;
  }

  return nextState;
};
