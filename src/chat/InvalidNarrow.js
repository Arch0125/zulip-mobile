/* @flow strict-local */

import React, { PureComponent } from 'react';
import type { Node } from 'react';
import { StyleSheet, View } from 'react-native';

import type { Narrow } from '../types';
import { ZulipTextIntl } from '../common';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    fontSize: 20,
    paddingLeft: 10,
    padding: 8,
  },
});

type Props = $ReadOnly<{|
  narrow: Narrow,
|}>;

export default class InvalidNarrow extends PureComponent<Props> {
  render(): Node {
    return (
      <View style={styles.container}>
        <ZulipTextIntl style={styles.text} text="That conversation doesn't seem to exist." />
      </View>
    );
  }
}
