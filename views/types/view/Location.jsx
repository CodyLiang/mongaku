"use strict";

const React = require("react");

const LocationView = React.createClass({
    propTypes: {
        name: React.PropTypes.string.isRequired,
        type: React.PropTypes.string.isRequired,
        value: React.PropTypes.arrayOf(
            React.PropTypes.shape({
                _id: React.PropTypes.string.isRequired,
                city: React.PropTypes.string,
                name: React.PropTypes.string,
            })
        ).isRequired,
    },

    renderName(location) {
        const searchURL = require("../../../logic/shared/search-url");
        const url = searchURL(this.props, {
            [this.props.name]: location.name,
            type: this.props.type,
        });

        return <span>
            <a href={url}>{location.name}</a><br/>
        </span>;
    },

    render() {
        return <div>
            {this.props.value.map((location) => <span key={location._id}>
                {location.name && this.renderName(location)}
                {location.city && <span>{location.city}<br/></span>}
            </span>)}
        </div>;
    },
});

module.exports = LocationView;
